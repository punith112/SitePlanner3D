# SitePlanner3D

Offline, single-file 2D/3D BIM site planner for commercial kitchens & MEP — draw walls, place equipment, route ducts and pipes, then get BOQ and engineering checks. No install, no server: open `index.html` in a browser.

## Run
Open `index.html` in Chrome / Edge / Firefox. Everything runs locally; plans autosave in the browser and can be exported as save files.

## Highlights
- 2D plan + live 3D view, multi-floor, walkthrough mode
- Walls, doors/windows (editable swing), slabs, pillars, stairs, fences, zones, roofs, ceilings, snap-grid — every element is selectable, movable, rotatable, editable and deletable after placement (Move/Select tools, Del key, right-click editors)
- HVAC duct routing (exhaust/fresh), plumbing pipes (CW/HW/drain), rich equipment library (cook line, hoods, refrigeration incl. walk-in cold room, services incl. MCB, grease trap, fire extinguisher)
- One-click BIM engineering report (electrical load, pipe sizing, ventilation CFM, clearances) + BOQ CSV export
- Model exchange: export IFC / STEP / IGES / OBJ, import IGS / OBJ
- CAD Co-pilot — scores the design 0-100 against good-practice standards (access & door swings, work triangle, landing space, aisle widths, hood coverage, hygiene, zoning, stairs, ventilation balance, grease trap, duct velocity, electrical protection, fire & storage, maintenance conflicts) with clickable on-plan markers
- Brief -> Design — paste a plain-language project brief; a persona pipeline (summarise -> classify facility type -> extract requirements -> generate) draws the complete layout and self-reviews it with the Co-pilot

## AI bridge (optional)
`ai-bridge/` connects the open page to Kimi and Claude for text-to-CAD, design review, BOQ Q&A and full MCP control from Claude Desktop / Kimi CLI (20 tools).

```bash
cd ai-bridge
cp .env.example .env    # add KIMI_API_KEY and/or ANTHROPIC_API_KEY
npm install
npm start               # web bridge on http://127.0.0.1:8787
npm run mcp             # MCP stdio server (Claude Desktop / Kimi CLI)
```

Then open `index.html` and click **AI.KIMI** / **AI.Claude** in the top bar, or configure the MCP server in Claude Desktop:

```json
{ "mcpServers": { "siteplanner3d": { "command": "node", "args": ["<path>/ai-bridge/server.js", "--mcp"] } } }
```

## Files
- `index.html` — the entire app (single file, Three.js via CDN)
- `manual.html`, `SitePlanner3D_User_Manual.pdf`, `SitePlanner3D_User_Manual.docx` — user manual
- `ai-bridge/` — local AI bridge + MCP server (`server.js`, no framework, one dependency)
