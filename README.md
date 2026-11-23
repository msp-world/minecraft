# minecraft

Minecraft 机器人的 MSP World 节点。此仓库作为 [msp-world-cli](https://github.com/msp-world/msp-world-cli) 的子模块使用，依赖同级 `shared` 和主仓库中的 `msp-ts`，不能仅克隆本仓库后直接运行。

## 使用

需要 Node.js 22.6 或更新版本。

```bash
git clone --recurse-submodules https://github.com/msp-world/msp-world-cli.git
cd msp-world-cli
npm start -- minecraft
```

主要配置：MC_HOST、MC_PORT、MC_USERNAME、MC_VERSION、MC_AUTH。通用连接配置及详细说明见[主仓库](https://github.com/msp-world/msp-world-cli)。
Minecraft 需要先在主仓库运行 `npm install` 安装 Mineflayer。

## 上游与致谢

源码注明对齐 [Pal-AI-Lab/Cortico](https://github.com/Pal-AI-Lab/Cortico) 的 Minecraft World；具体原作者尚未核实。

本仓库是 MSP 适配实现，并非上游原仓库。感谢上游作者及贡献者。
