# Ookla test with your frontend unchanged

- Frontend served from: `./frontend/` (files are **untouched**).
- Backend: Node.js + Ookla Speedtest CLI (`/api/speedtest`), default server **DJEZZY (Algiers) ID 10432**.
- Optional test page: `/ookla` (does not modify your files).

## Run
1) Install Node.js 18+
2) Install Ookla CLI (Windows: download `speedtest.exe` from https://www.speedtest.net/apps/cli ; Linux: use packagecloud)
3) Start:
```bash
npm install
# Optional: override server if an Oran Djezzy ID appears in `speedtest -L`
# Windows PowerShell:
#   setx SERVER_ID 12345
#   (then open a NEW PowerShell)
# Linux/macOS:
#   export SERVER_ID=12345
npm start
```
- Open your original site: `http://localhost:8080/`
- JSON endpoint: `http://localhost:8080/api/speedtest`
- Optional UI: `http://localhost:8080/ookla`

## Inspection Artifacts
See the `inspection/` folder (manifest.csv, deep_inspection.json, deep_inspection_summary.md, tree.txt).
