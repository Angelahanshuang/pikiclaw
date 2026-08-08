### 本地开发启动
1. 在 ./pikiloom-local 改代码。
2. 在 ./pikiloom-local 执行 npm run dev，
3. 查看日志 tail -f ~/.pikiloom/dev/dev.log

### npm打包，在其他机器运行
1. 在 ./pikiloom-local 执行 npm run build
2. npm pack --pack-destination /tmp
3. 在其他机器上执行 卸载 安装 启动
npm uninstall -g pikiloom
npm install -g /tmp/pikiloom-0.4.84.tgz
pikiloom 启动


### 怎么进行 Debug？ （弃用）
项目的根目录下创建了 .vscode/launch.json 文件，配置好了 Debug 环境

#### 场景 1：你想 Debug 整个主程序（例如飞书接收消息的链路）
1. 在你需要打断点的文件（比如 pikiloom-local/src/channels/feishu/bot.ts 的 handleMessage 方法）里，点击行号左侧，打上一个红色的断点。
2. 在左侧边栏找到 "运行和调试" (Run and Debug) 面板（或者按 Cmd + Shift + D ）。
3. 顶部的下拉菜单里会多出一个选项： Debug Feishu Live POC 。
4. 点击绿色的“播放”按钮（Start Debugging）。
5. 此时去飞书群里发一条消息。当程序执行到你打断点的那一行时，IDE 就会停住，你可以查看当前内存里的所有变量（比如 ctx.from.openId 是什么）、单步跳过（Step Over）、或者步入（Step Into）源码。 
#### 场景 2：你想 Debug 我们刚写的某个测试文件
1. 比如你想 Debug pikiloom-local/tests/integration/intent-router.test.ts 。
2. 直接打开这个测试文件，打好断点。
3. 在终端里，使用 node --inspect-brk 或者直接借助 tsx 的内置 Debug：
```Bash
cd pikiloom-local
NODE_OPTIONS='--inspect' npx tsx tests/integration/intent-router.test.ts
```
#### 注意事项：Source Map
debug调试的是 pikiloom-local 这个底层包，而它是用 TypeScript 写的，最终被 Node.js 执行的是编译后的 dist/**/*.js 。
我已经在 launch.json 里为你配置了 sourceMaps: true 和正确的 outFiles 路径。这意味着你 直接在 .ts 源码里打断点 ，IDE 会自动通过 source map 映射到运行时的 JS 上，体验非常丝滑。但请记住： 每次你修改了 pikiloom-local 的源码后，必须先跑一遍 npm run build ，否则断点会错位或不生效。

使用 cd pikiloom-local && npx tsc --sourceMap --noEmitOnError false 来编译，确保 Source Map 每次都能成功生成