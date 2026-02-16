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
npm run dev
```

Open the URL printed by Vite (default: `http://localhost:5173`).

## Build

```bash
npm run build
npm run preview
```

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
