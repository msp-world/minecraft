/**
 * Minecraft MSP 节点启动入口。
 *
 * 环境变量：
 *   MC_HOST      服务器地址（默认 127.0.0.1）
 *   MC_PORT      服务器端口（默认 25565）
 *   MC_USERNAME  机器人用户名（默认 CortiBot）
 *   MC_VERSION   游戏版本（默认 1.20.6）
 *   MC_AUTH      offline / microsoft（默认 offline）
 */
import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { MinecraftWorld } from "./world.ts";

export async function startMinecraftNode(): Promise<{ node: MSPNode; world: MinecraftWorld }> {
  const node = new MSPNode(process.env.MC_NODE_ID || "minecraft", mspOptionsFromEnv("MC"));
  const world = new MinecraftWorld({
    host: process.env.MC_HOST || "127.0.0.1",
    port: process.env.MC_PORT ? Number(process.env.MC_PORT) : 25565,
    username: process.env.MC_USERNAME || "CortiBot",
    version: process.env.MC_VERSION || "1.20.6",
    auth: process.env.MC_AUTH === "microsoft" ? "microsoft" : "offline",
  });

  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[minecraft] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startMinecraftNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
