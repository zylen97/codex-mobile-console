# Codex Mobile Console

Android/iPad friendly remote console for controlling local Codex sessions on a Mac.

## What This Is

This project runs a local Gateway on the Mac. The Gateway talks to `codex app-server` over stdio and exposes a narrow mobile API:

- allowlisted projects from `config/projects.json`
- multiple Codex sessions per project
- live assistant streaming over WebSocket
- mobile approval cards for command/file-change prompts
- PWA UI that can be installed on Android Chrome or opened on iPad
- Capacitor config for an Android wrapper

The Gateway is intentionally separate from `codex app-server`. Do not expose `codex app-server` directly to the network.

## Install

```bash
cd codex-mobile-console
npm install
```

## Run Locally

```bash
npm run dev
```

Open the UI on the Mac:

```text
http://127.0.0.1:5178
```

The Gateway prints a device token on startup. The same token is stored at:

```text
.data/device-token.txt
```

## Run From Android Or iPad With Tailscale

Start both Gateway and mobile UI on all interfaces:

```bash
npm run dev:lan
```

On Android/iPad, open:

```text
http://<mac-tailscale-ip>:5178
```

In the settings modal:

```text
Gateway URL: http://<mac-tailscale-ip>:8787
Device Token: value from .data/device-token.txt
```

Recommended: use Tailscale and keep this off the public internet. If you use another tunnel, put real auth and HTTPS in front of it.

## Run In tmux

```bash
tmux new -s codex-console
cd codex-mobile-console
npm run dev:lan
```

Detach with `Ctrl-b d`, resume with:

```bash
tmux attach -t codex-console
```

## Configure Projects

By default the Gateway exposes this repository as one project. To add your own projects, create:

```text
config/projects.json
```

You can start from the example:

```bash
cp config/projects.example.json config/projects.json
```

Each project should use an absolute path for day-to-day use:

```json
{
  "id": "my-project",
  "name": "My Project",
  "path": "/absolute/path/to/project",
  "defaultModel": "gpt-5.4",
  "defaultSandbox": "workspace-write",
  "defaultApprovalPolicy": "on-request"
}
```

`config/projects.json` is gitignored because it usually contains local machine paths.

Keep `defaultApprovalPolicy` as `on-request` for mobile control. Avoid `danger-full-access` unless you are sitting at the computer and know exactly why you need it.

## Android App Path

The fastest first version is the PWA:

1. Open the UI in Android Chrome.
2. Use Chrome menu -> Add to Home screen.

For a native Android wrapper, install the local build tools first:

```bash
brew install openjdk@21
brew install --cask android-commandlinetools
```

Use the Homebrew JDK and Android SDK in the current shell:

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT=/opt/homebrew/share/android-commandlinetools
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"
```

Accept Android SDK licenses and install the SDK packages used by the app:

```bash
yes | sdkmanager --licenses
sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"
```

Build a debug APK:

```bash
npm run android:debug-apk
```

The generated APK is written to:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

This is a debug APK for personal sideloading. A Play Store or public release build needs a release keystore and a separate signing step.

## GitHub APK Build

This repository includes a GitHub Actions workflow at `.github/workflows/android-debug-apk.yml`.

Use it from GitHub:

1. Open the repository Actions tab.
2. Choose `Build Android Debug APK`.
3. Click `Run workflow`.
4. Download the `codex-console-debug-apk` artifact after the run completes.

## Safety Notes

- The Gateway defaults to `127.0.0.1`; use `npm run dev:lan` only on a trusted private network or Tailscale.
- Every API and WebSocket call requires the device token.
- Projects are allowlisted. The phone cannot choose arbitrary folders.
- Codex command and file-change approvals are routed back to the phone.
- The mobile UI intentionally shows concise summaries. Do detailed diff review on the Mac before commits or pushes.

## Useful Commands

```bash
npm run check
npm run build
npm run start
```
