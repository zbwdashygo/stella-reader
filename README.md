# Stella 星阅

Windows 与 Android EPUB 阅读、听书工具。当前版本 **2.1.0**。

- 书库、目录、搜索、排版和主题设置。
- 手机翻页动画，翻页与连续滑动模式切换，左下角显示章内页码及全书进度。
- 同一 Wi-Fi 下同步书籍和阅读进度，也可通过 `STELLA1` 进度码跨端定位。
- 手机独立联网使用 Edge 在线音色；2.1.0 验证时目录含 322 个音色、14 个中文音色，服务目录可能变化。
- 一键同步电脑的音色列表、当前音色和语速。电脑系统及私有 API 声音需要电脑在线；服务密钥留在电脑。
- Windows 鼠标前侧键向前翻页，后侧键向后翻页。
- Stella 品牌界面和启动动画。

## 下载与安装

在本仓库 **Releases** 中下载 Android APK 或 Windows 便携包（以实际发布的附件为准）。

Android 需要 Android 8.0 或更新系统。已有官方版本时直接覆盖安装，避免卸载导致手机本地数据丢失。自行编译的 APK 与发布版签名可能不同，不能直接覆盖安装。

Windows 便携包解压后双击 `Stella星阅.vbs`。升级现有程序前先备份，保留原程序的 `data/` 目录；不要将空数据目录覆盖到已有书库。

## 从源码启动 Windows 版

安装 Node.js 20 或更新版本，在仓库目录执行：

```powershell
npm ci
npm start
```

仓库附带用于在线音色的 Windows Python 3.12 运行时与 Python 依赖。Electron 由 `npm ci` 安装。

本地服务默认监听 `127.0.0.1:8787`。只运行服务可执行 `npm run server`。书籍索引、阅读记录及声音配置在本地 `data/` 目录生成。

## 手机连接电脑

1. 电脑与手机连接同一 Wi-Fi，打开电脑端。
2. 电脑端点 **✦ 同步**，开启 Wi-Fi 同步并复制配对码。
3. 手机书架点 **同步小说**，粘贴配对码后连接。
4. 点 **一键下载缺少的小说**，完成后可离线阅读。
5. 在一本书的 **更多声音与来源 → 一键同步电脑音色** 中导入电脑音色及朗读设置。

配对码包含访问电脑书库的凭据，只发给自己的设备。IP 地址变化后重新复制配对码；关闭 Wi-Fi 同步可撤销旧码。跨网络时可生成阅读进度码，再通过自己的聊天工具发送到另一台设备。进度码不包含小说正文，两端需要同一份 EPUB。

在线朗读会把当前待朗读文字发送给所选语音服务。默认本地阅读不上传小说。手机的原生系统朗读进入后台时暂停，回到应用后可继续。

## 编译 Android

需要 Python 3、JDK 17、Android SDK Platform 35 和 Build Tools 35.x。设置 `JAVA_HOME`、`ANDROID_HOME`，执行：

```powershell
python scripts/build-android.py
```

输出在 `dist/`，默认使用自动生成的本地开发签名。正式发布时设置 `STELLA_KEYSTORE`、`STELLA_KEY_ALIAS`、`STELLA_STORE_PASSWORD`，使用自己的持久签名。不要提交签名文件或密码。

## 验证

```powershell
npm run make-fixtures -- --download-english
npm run test:e2e
node test/mobile-paging.cjs
node test/stella-e2e.cjs
node test/voice-sync.cjs
node test/mobile-voice-sync.cjs
```

测试使用独立临时数据。部分测试需要 Windows、已安装 Microsoft Edge，以及可访问在线语音服务的网络。书籍测试样例由脚本生成或从 Project Gutenberg 下载，不随源码提交。

## 数据与第三方组件

本仓库不包含个人小说、书库、阅读记录、配对码、API 密钥或 Android 发布签名。`.gitignore` 默认排除这些文件。

应用代码尚未指定开源许可证。第三方组件保留各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
