#!/usr/bin/env node
/**
 * ESA 边缘节点部署：把组装好的静态站点（_site/）以 Assets 模式发布到
 * 阿里云 ESA Functions & Pages，生产环境 100% 灰度。
 *
 * 用法: node deploy-esa.mjs <routine-name> <site-folder> [description]
 *   routine-name  函数名（小写字母/数字/连字符，字母开头，长度 ≥ 2）
 *   site-folder   静态站点目录（如 ../../../_site）
 *
 * 凭证走 @alicloud/credentials 默认凭证链：CI 中由 workflow 注入
 * ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET（仓库 Secrets）；
 * 本地运行也可用同名环境变量。
 *
 * 同名 routine 已存在时按"发布新版本"处理；CreateRoutine 仅接受
 * 成功 / RoutineNameAlreadyExist / Throttling.Api（重试一次）三种结果，
 * 其余错误立即中止，防止把半成品发布上去。
 *
 * 访问方式：
 *   - 已绑定域名（ESA 控制台 → 域名绑定）直接访问，免 token；
 *   - 调试域名（defaultRelatedRecord）需附加 1 小时有效的 esa_er_token。
 */
import Esa20240910 from "@alicloud/esa20240910";
import OpenApi from "@alicloud/openapi-client";
import TeaUtil from "@alicloud/tea-util";
import Credential from "@alicloud/credentials";
import JSZip from "jszip";
import * as fs from "fs";
import * as path from "path";

function createClient() {
  const credential = new Credential.default();
  const config = new OpenApi.Config({
    credential,
    endpoint: "esa.cn-hangzhou.aliyuncs.com",
    userAgent: "AirFerry/esa-deploy",
  });
  return new Esa20240910.default(config);
}

// 边缘函数服务未开通时先开通（GetErService 是唯一权威检查方式）
async function ensureServiceEnabled(client) {
  try {
    const status = await client.getErService(new Esa20240910.GetErServiceRequest({}));
    if (status.body?.status === "online" || status.body?.status === "Running") return;
  } catch {
    // 检查失败不阻塞，直接尝试开通
  }
  console.log("Enabling Edge Routine service...");
  try {
    await client.openErService(new Esa20240910.OpenErServiceRequest({}));
    console.log("Edge Routine service enabled.");
  } catch (e) {
    if (e.code === "ErService.HasOpened" || e.message?.includes("HasOpened")) return;
    throw e;
  }
}

// CreateRoutine：仅成功 / 已存在 / 限流重试三种结果可继续，其余直接抛出
async function createRoutineOrExisting(client, name, description) {
  try {
    await client.createRoutine(new Esa20240910.CreateRoutineRequest({ name, description }));
    console.log("Routine created.");
    return;
  } catch (e) {
    if (isAlreadyExists(e)) {
      console.log("Routine already exists, publishing a new version...");
      return;
    }
    if (e.code === "Throttling.Api") {
      console.log("Throttled, retrying in 2 seconds...");
      await new Promise((r) => setTimeout(r, 2000));
      try {
        await client.createRoutine(new Esa20240910.CreateRoutineRequest({ name, description }));
        console.log("Routine created.");
        return;
      } catch (retryError) {
        if (isAlreadyExists(retryError)) {
          console.log("Routine already exists, publishing a new version...");
          return;
        }
        throw retryError;
      }
    }
    throw e;
  }
}

function isAlreadyExists(e) {
  return (
    e.code === "RoutineNameAlreadyExist" ||
    e.code === "RoutineAlreadyExist" ||
    e.message?.includes("already exist")
  );
}

async function deployFolder(name, folderPath, description) {
  const client = createClient();
  const runtime = new TeaUtil.RuntimeOptions({});

  // 0. 确保边缘函数服务已开通
  await ensureServiceEnabled(client);

  // 1. 创建 routine（已存在则复用）
  console.log(`Creating routine: ${name}...`);
  await createRoutineOrExisting(client, name, description);

  // 2. 申请 assets 代码版本 + OSS 上传凭证
  console.log("Creating assets code version...");
  const params = new OpenApi.Params({
    action: "CreateRoutineWithAssetsCodeVersion",
    version: "2024-09-10",
    protocol: "https",
    method: "POST",
    authType: "AK",
    bodyType: "json",
    reqBodyType: "json",
    style: "RPC",
    pathname: "/",
  });
  const body = { Name: name, CodeDescription: description };
  const result = await client.callApi(
    params,
    new OpenApi.OpenApiRequest({ body }),
    runtime
  );
  const ossConfig = result.body?.OssPostConfig || {};
  const codeVersion = result.body?.CodeVersion;
  console.log(`Code version: ${codeVersion}`);

  // 3. 打包 zip（ASSETS_ONLY 结构：全部文件置于 assets/ 前缀下）并上传
  console.log("Packaging files...");
  const zip = new JSZip();
  let fileCount = 0;
  const addFiles = (dir, zipPath = "") => {
    for (const file of fs.readdirSync(dir).sort()) {
      const fullPath = path.join(dir, file);
      const zipFilePath = zipPath ? `${zipPath}/${file}` : file;
      if (fs.statSync(fullPath).isDirectory()) {
        addFiles(fullPath, zipFilePath);
      } else {
        zip.file(`assets/${zipFilePath}`, fs.readFileSync(fullPath));
        fileCount++;
      }
    }
  };
  addFiles(folderPath);
  console.log(`Packaged ${fileCount} files.`);

  const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
  console.log(`Zip size: ${(zipBuffer.length / 1024).toFixed(1)} KB`);

  console.log("Uploading to OSS...");
  const formData = new FormData();
  formData.append("OSSAccessKeyId", ossConfig.OSSAccessKeyId);
  formData.append("Signature", ossConfig.Signature);
  formData.append("policy", ossConfig.Policy);
  formData.append("key", ossConfig.Key);
  if (ossConfig.XOssSecurityToken) {
    formData.append("x-oss-security-token", ossConfig.XOssSecurityToken);
  }
  formData.append("file", new Blob([zipBuffer]));
  const controller = new AbortController();
  const uploadTimeout = setTimeout(() => controller.abort(), 120000);
  try {
    await fetch(ossConfig.Url, { method: "POST", body: formData, signal: controller.signal });
  } finally {
    clearTimeout(uploadTimeout);
  }

  // 4. 轮询构建状态
  console.log("Waiting for build...");
  const infoParams = new OpenApi.Params({
    action: "GetRoutineCodeVersionInfo",
    version: "2024-09-10",
    protocol: "https",
    method: "GET",
    authType: "AK",
    bodyType: "json",
    reqBodyType: "json",
    style: "RPC",
    pathname: "/",
  });
  for (let i = 0; i < 300; i++) {
    const info = await client.callApi(
      infoParams,
      new OpenApi.OpenApiRequest({ query: { Name: name, CodeVersion: codeVersion } }),
      runtime
    );
    const status = (info.body?.Status || "").toLowerCase();
    if (status === "available") {
      console.log("Build ready.");
      break;
    }
    if (status && status !== "init") {
      throw new Error(`Build failed: ${status}`);
    }
    process.stdout.write(".");
    await new Promise((r) => setTimeout(r, 1000));
  }

  // 5. 发布到生产环境（100%）
  console.log("Deploying to production...");
  const deployParams = new OpenApi.Params({
    action: "CreateRoutineCodeDeployment",
    version: "2024-09-10",
    protocol: "https",
    method: "POST",
    authType: "AK",
    bodyType: "json",
    reqBodyType: "json",
    style: "RPC",
    pathname: "/",
  });
  await client.callApi(
    deployParams,
    new OpenApi.OpenApiRequest({
      query: {
        Name: name,
        Env: "production",
        Strategy: "percentage",
        CodeVersions: JSON.stringify([{ Percentage: 100, CodeVersion: codeVersion }]),
      },
    }),
    runtime
  );

  // 6. 取调试域名访问 URL（绑定域名无需 token，这里仅输出备用）
  const routine = await client.getRoutine(new Esa20240910.GetRoutineRequest({ name }));
  let url = routine.body.defaultRelatedRecord
    ? `https://${routine.body.defaultRelatedRecord}`
    : null;
  if (url) {
    const tokenParams = new OpenApi.Params({
      action: "GetRoutineAccessToken",
      version: "2024-09-10",
      protocol: "https",
      method: "GET",
      authType: "AK",
      bodyType: "json",
      reqBodyType: "json",
      style: "RPC",
      pathname: "/",
    });
    const tokenRes = await client.callApi(
      tokenParams,
      new OpenApi.OpenApiRequest({ query: { Name: name } }),
      runtime
    );
    const token = tokenRes.body?.Token;
    if (token) {
      url += `?esa_er_token=${token}`;
      console.log("⏰ Token is valid for 1 hour");
    }
  }
  return url;
}

function validateName(name) {
  const pattern = /^[a-z][a-z0-9-]{1,}$/;
  if (!pattern.test(name)) {
    throw new Error(
      `Invalid name "${name}". Must start with a lowercase letter, contain only lowercase letters/numbers/hyphens, and be at least 2 characters long.`
    );
  }
}

// CLI
const [, , name, folderPath, description] = process.argv;
if (!name || !folderPath) {
  console.log("Usage: node deploy-esa.mjs <name> <site-folder> [description]");
  console.log("  name:        routine name (lowercase letters/numbers/hyphens, letter first)");
  console.log("  site-folder: assembled static site directory (e.g. ../../../_site)");
  process.exit(1);
}

validateName(name);
const resolvedFolder = path.resolve(folderPath);
if (!fs.existsSync(resolvedFolder) || !fs.statSync(resolvedFolder).isDirectory()) {
  console.error(`Error: "${resolvedFolder}" is not a valid directory.`);
  process.exit(1);
}

deployFolder(name, resolvedFolder, description || "")
  .then((url) => {
    console.log("\n✅ Deployment successful!");
    console.log(`Bound domains (no token needed): https://air.weiqingyuan.com  https://air.surl.vip`);
    console.log(`Debug URL (token, 1h): ${url}`);
    console.log("\n💡 Note: if the link is unreachable immediately, DNS may not have propagated yet. Retry in a minute.");
  })
  .catch((err) => {
    console.error("\n❌ Deployment failed:", err.message);
    process.exit(1);
  });
