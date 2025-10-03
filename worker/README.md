Replicator Worker (MVP)

Purpose: single-process loop that handles one order at a time.

Phases
- Generate (Meshy) → save raw mesh to Supabase Storage; status=repairing
- Repair/Validate (meshfix + Blender) → save repaired STL; status=slicing
- Slice & Quote (Bambu Studio CLI) → save 3MF + preview; compute price; status=ready_to_pay
- Dispatch (after payment) → Phase 1: produce bambu-connect:// link; status=dispatching → printing

- Environment
- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_STORAGE_BUCKET
- MESHY_API_KEY
- MESHY_IMAGE_MODEL (default `latest`)
- MESHY_MULTI_MODEL (default `meshy-5` for multi-view)
- MESHY_TARGET_POLYCOUNT (optional)
- I23D_TRELLIS_FALLBACK=1 to keep legacy FAL Trellis as a safety net
- I23D_PROXY_HEIGHTMAP=1 to re-enable the instant bas-relief preview (defaults off)
- BAMBUSTUDIO_PROFILE_PATH
  (or) BAMBUSTUDIO_UPTODATE_SETTINGS_PATH (flattened settings.json)
- PATH to meshfix, admesh, blender CLI tools
- Optional: `BAMBU_STUDIO_CLI_HEADLESS` / `BAMBU_STUDIO_CLI_LINUX` pointing at a native `bambu-studio-cli` binary (auto-detected when present).
- Geometry hygiene (optional but recommended):
  - AUTO_BASE_TRIM_MM=0.3   # tiny planar trim to guarantee a printable first layer
  - REPAIR_SOLIDIFY=1       # add thickness for thin shells
  - REPAIR_SOLIDIFY_THICKNESS_MM=1.6

Native Headless CLI (recommended)
- Install the official headless CLI (`bambu-studio-cli` AppImage or Windows CLI build).
- Ensure the binary is on PATH or set `BAMBU_STUDIO_CLI_HEADLESS` / `BAMBU_STUDIO_CLI_LINUX`.
- The worker logs the resolved CLI path on startup and skips the WSL bridge whenever a headless binary is detected.

WSL Option (Windows + Ubuntu/WSL)
- Install Bambu Studio on Windows (e.g., C:\\Program Files\\Bambu Studio\\BambuStudio.exe)
- In worker/.env:
  - BAMBU_STUDIO_CLI="/mnt/c/Program Files/Bambu Studio/BambuStudio.exe"
  - BAMBUSTUDIO_PROFILE_PATH points to a .3mf profile (will be copied to C: for slicing)
  - WIN_OUT_DIR=/mnt/c/PrintJobs (shared folder for inputs/outputs)
- The worker will stage the STL and profile under WIN_OUT_DIR, call the Windows CLI, then upload the resulting 3MF/preview.
- Run ./doctor.sh to verify: it will detect WSL and perform a Windows‑CLI slice smoke test.

Uptodate Snapshot (recommended)
- Export a flattened snapshot JSON from a golden 3MF once:
  bambu-studio --slice 0 --export-settings C:\\slicing\\presets\\settings.json C:\\slicing\\golden\\golden_cube.3mf
- In worker/.env set:
  - BAMBUSTUDIO_UPTODATE_SETTINGS_PATH (use /mnt/c path when under WSL)
- doctor.sh and the worker will detect this and call the CLI with:
  --uptodate --uptodate-settings <settings.json> --arrange 1 --load-defaultfila --slice 0 --export-3mf <out.3mf> <model.stl>

Profile‑Direct Mode (robust on 02.02.01.60)
- Use a Golden Project 3MF saved in the GUI (X1C 0.4, process, filament) and call the CLI directly on it.
- In worker/.env set only:
  - BAMBUSTUDIO_PROFILE_PATH="/mnt/c/Bambu/Profiles/Golden_X1C_0p4_Project.3mf"
  - BAMBU_STUDIO_CLI and WIN_OUT_DIR as usual
- The worker (WSL bridge) runs:
  - bambu-studio.exe --arrange 1 --load-defaultfila --slice 0 --export-3mf <out.3mf> <profile.3mf> <model.stl>
- doctor.sh uses the same profile‑direct command in its WSL profile branch.

Fail‑Proof Guardrails
- Single snapshot: export with the same CLI EXE you use headless and reuse it.
- Prefer `--uptodate --uptodate-settings`: more tolerant to schema drift than `--load-settings`.
- Geometry hygiene: enabling `AUTO_BASE_TRIM_MM` ensures layer 0 is never empty without manual “Cut → Place on cut”.
- Filament: if not embedded in the snapshot, also set `BAMBUSTUDIO_FILAMENTS_PATH` and the worker will include `--load-filaments`.
- Default filament: the worker includes `--load-defaultfila` when supported.
- Overlay chaining: you can chain multiple JSONs in `BAMBUSTUDIO_UPTODATE_SETTINGS_PATH` using `;` (or `,`). Place a tiny overlay last to pin variant/nozzle if needed, e.g.
  {"printer_extruder_variant":"0.4","print_extruder_variant":"0.4","printer_extruder_id":0,"print_extruder_id":0,"nozzle_diameter":0.4}
- Doctor preflight: `doctor.sh` checks your snapshot(s) for variant/nozzle keys and echos the exact CLI command used.
- Automatic fallback: if slicing fails with an extruder/nozzle variant error, the worker automatically exports fresh settings from your locked 3MF and re‑slices with those JSON settings.

Using JSON Presets
- Instead of a settings-3MF, you can use JSON presets (preferred if you manage separate machine/process/filament files).
- In worker/.env:
  - BAMBUSTUDIO_SETTINGS_PATH="/mnt/c/bambu/x1c_machine.json;/mnt/c/bambu/pla_024.json"
  - BAMBUSTUDIO_FILAMENTS_PATH="/mnt/c/bambu/pla_filament.json"
- doctor.sh and the worker will detect these and call the CLI with:
  --load-settings <joined-jsons> --load-filaments <filament.json> --slice 0 --export-3mf <out.3mf> <model.stl>

Upgrade Playbook
- Pin a CLI version and keep a versioned snapshot JSON (filename + checksum).
- On upgrade, regenerate the snapshot with the new EXE from the same Golden 3MF, run `doctor.sh`, and re‑slice a golden model to validate determinism (time/grams match GUI).

Run
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python main.py
