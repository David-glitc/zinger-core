# Zinger Core

Polymarket BTC/ETH prediction market trading engine featuring high-conviction signal execution, multi-horizon ONNX deep learning overlays, an operator dashboard, and an automated regime governor.

> This public repository contains **Zinger Core** written in **TypeScript** (Python machine learning models under `ml/`). Runtime ledgers, private keys, and live credentials are not checked into Git.

---

## ⚡ Features

- **Polymarket Binary Options**: Automated paper and live trading across 5m, 15m, 30m, and 1h windows.
- **Multi-Horizon BiLSTM ONNX Models**: Native in-process Node.js inference (`< 2ms` latency) evaluating 17 deep learning networks.
- **Fractional Kelly Position Sizing**: Probability-scaled bet sizing with risk-reward ratio adjustments.
- **Asymmetric Sweet-Spot Banding**: Configurable price filters ($0.44–$0.62) maximizing win ROI while capping stop-loss exposure.
- **Operator Dashboard UI**: React + Vite control panel served natively at `/poly`.
- **Automated Circuit Breaker**: Regime governor & LLM optimizer hooks for automated drawdown management.

---

## 🚀 Quick Start (Paper Trading)

### 1. Prerequisites & Installation

```bash
# Clone the repository
git clone https://github.com/NewGenesis04/zinger-core.git
cd zinger-core

# Install Node.js backend dependencies and build the UI
npm install
npm run build:frontend

# Setup environment file
cp .env.example .env
# Edit .env and set AUTH_PASSWORD=your_secure_password
```

### 2. Machine Learning Environment (Optional ML Overlay)

Zinger Core automatically detects and prioritizes Python virtual environments (`.venv` or `ml/.venv`).

```bash
# Install uv (fast Python package manager) if not installed
curl -LsSf https://astral.sh/uv/install.sh | sh

# Install dependencies using root pyproject.toml
uv sync

# Train LSTM models & export ONNX files
python ml/pipeline.py all
```

### 3. Launch Zinger Core

```bash
npm start
```

Open **`http://localhost:3000/poly`** in your browser, sign in with your `AUTH_PASSWORD`, and keep mode on **paper**.

---

## 🛠️ Machine Learning & ONNX Pipeline

Zinger Core uses an offline-trained PyTorch BiLSTM architecture that exports directly to ONNX format for zero-latency execution in Node.js.

```bash
# Fetch historical data, compute TA features, train models, and export ONNX models
python ml/pipeline.py all

# Alternatively, run standalone ONNX export on saved PyTorch checkpoints
python ml/export_onnx.py
```

Exported ONNX models and `manifest.json` are placed in `data/ml/models/onnx/`. Zinger Core automatically detects `manifest.json` and activates the **Phase 2 ONNX ML Overlay** in real-time.

---

## 🎛️ Operator Dashboard & Strategy Controls

All strategy knobs can be tuned dynamically via the **Config Drawer** on the web UI (`http://localhost:3000/poly` -> **Config ⚙️**):

| Parameter | Recommended | Purpose |
| :--- | :---: | :--- |
| `minConfidence` | `0.50` – `0.55` | Conviction threshold. Bypasses 30%–40% indicator noise during market chop. |
| `minPrice` / `maxPrice` | `0.44` / `0.62` | Asymmetric sweet-spot price band. Avoids buying expensive favorites (> $0.65) or deep underdogs (< $0.40). |
| `tpPctLow` / `tpPctHigh` | `10%` / `22%` | Mid-window Take Profit targets to lock in rapid price spikes. |
| `slPct` | `8%` | Hard Stop Loss percentage per contract ticket. |
| `adaptiveSl` | `true` | Dynamically tightens stop loss down to ~5% if trade is negative and momentum fades. |
| `evalBothSides` | `false` | When `false`, forces single-sided conviction trades per window (disables double-sided hedging). |
| `arbOnlyUntilEdge` | `false` | When `false`, unlocks immediate directional buys without requiring 40 paper trades. |
| `edgeMinTrades` | `0` | Paper warmup trade requirement before unlocking directional trades. |
| `governorEnabled` | `false` *(testing)* | When `false`, locks your manual strategy config without automatic gear-switching. |

---

## 🖥️ Production 24/7 VPS Deployment (`tmux` / PM2)

To run Zinger Core continuously on a Linux VPS:

```bash
# 1. Connect to your VPS and install Node 22 + tmux
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git tmux ufw

# 2. Open dashboard port 3000 on VPS firewall
sudo ufw allow 3000/tcp

# 3. Start Zinger Core inside a persistent tmux session
tmux new -s zinger
npm start

# Detach from tmux (leaves bot running 24/7):
# Press Ctrl + B, then press D
```

To re-attach to your live server screen at any time: `tmux attach -t zinger`.

---

## 📋 Available Scripts

| Command | Purpose |
| :--- | :--- |
| `npm start` | Run Zinger Core backend with `tsx` |
| `npm run dev` | Watch mode for development |
| `npm test` | Run backend Vitest unit tests |
| `npm run typecheck` | Backend TypeScript verification (`tsc --noEmit`) |
| `npm run typecheck:frontend` | Frontend TypeScript verification (`tsc --noEmit`) |
| `npm run build:frontend` | Compile Vite dashboard to `frontend/dist` |
| `npm run ci` | Run full CI suite (typecheck + unit + perf) |

---

## 🔐 Security & Safety

- **Paper Mode Default**: Always validate strategy setups in paper mode before live execution.
- **API Password Protection**: All `/api/*` endpoints require `AUTH_PASSWORD` session authentication.
- **Private Key Isolation**: Live wallet keys (`data/wallet.json`) and `.env` credentials are gitignored. Read [SECURITY.md](SECURITY.md) before live deployment.

---

## 📄 License

Licensed under the [Apache License, Version 2.0](LICENSE). See [NOTICE](NOTICE).
