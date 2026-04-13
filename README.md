<div align="center">
  <img src="assets/banner.svg" alt="seekio — your claude agents, at a glance" width="100%">
</div>

<br>

<div align="center">

[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-blue)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

## Install & Run

```bash
git clone https://github.com/zarionlabs/seekio.git
cd seekio
node seekio.js
```

Open **http://localhost:3456** in your browser. No dependencies to install.

## What It Does

seekio watches your running Claude Code sessions and shows their status in real time —
working, thinking, or idle — in a terminal dashboard or a pixel art office scene.
Two views, zero setup.

## Options

| Flag | Default | Description |
|------|---------|-------------|
| `--port <n>` | `3456` | Port to listen on |
| `--host <ip>` | `127.0.0.1` | Bind address |

**Access from your phone** (same Wi-Fi):

```bash
node seekio.js --host 0.0.0.0
```

The LAN address is printed at startup. Open it on your device.

## License

MIT
