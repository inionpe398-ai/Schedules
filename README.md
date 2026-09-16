# Schedule App (React)

Solid React-based university schedule manager with:
- Fixed slot timetable (12 slots from 08:45 to 17:45)
- Conflict-safe registration (one lecture + one section per course)
- Course preview toggles:
  - `All Lectures`
  - `All Sections`
- Full Screen mode to show timetable only
- LocalStorage persistence

## Run

```bash
npm install
copy .env.example .env
npm run dev
```

Set `DULMS_USERNAME`, `DULMS_PASSWORD`, and a strong `ADMIN_API_KEY` in the server environment. The DULMS credentials and cookies never enter the browser bundle. Open `/admin` for catalog refresh, dry-run preview, change review, apply, hall coverage, and per-level PDF export.

Open the URL printed by Vite (default: `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

The production server hosts both the API and `dist/`. Level links use `?level=1` through `?level=5`, while each sync scope is isolated in storage.

## Data Files

Put each course as one JSON file inside `data/`.

Update `data/manifest.json`:

```json
{
  "files": [
    "Infection.json",
    "Operative.json"
  ]
}
```

The app loads exactly the listed files.
