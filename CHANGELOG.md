# Changelog

CodexGauge is in preview. Public preview releases include a download or a signed update. Earlier milestones describe local development.

## RC24 · 1.0.0-rc.24

- Save the first official Token total for each UTC date and record every later revision. The dashboard shows when the value was observed, the previous and new totals, and the change.
- Include the tray default, daily quota display, and reconciliation improvements from RC20–RC23.

## RC20–RC23 · Local milestones

| Version | Changes |
| --- | --- |
| RC23 | Fresh installations default to closing to the tray. Existing preferences are respected. |
| RC22 | Use a nearby session reading from the same quota cycle when live collection misses the start of the day. Keep collection gaps visible. |
| RC21 | Show reconciliation for the latest completed UTC day and label estimates that use uncalibrated reference coefficients. |
| RC20 | Show observed and estimated daily quota side by side. Sum priced non-compaction rows for the estimate. |

## Previous public previews

| Version | Changes |
| --- | --- |
| RC19 | Fixed installation from the updater when the executable path contains Chinese characters. |
| RC18 | Preserve verified request usage, prefer live quota readings, show collection gaps, and withdraw change conclusions when local evidence is invalidated. |
| RC17 | Configured the GitHub preview channel and verified signed update files online. |

## Earlier local milestones

| Version | Changes |
| --- | --- |
| RC16 | GitHub Releases support for signed incremental updates. |
| RC15 | Separate readings around quota resets and label conflicts. Show compaction without unverified model attribution. |
| RC14 | Custom installation directory, startup and desktop shortcuts, and optional data removal during uninstall. |
| RC13 | Retry short-lived Windows file locks during installation. |
| RC12 | Unified app, taskbar, tray, and installer icons. |
| RC11 | Clarified calibration progress when first validation is rejected or the active cycle is unknown. |
| RC10 | Migration guidance for earlier portable installs. |
| RC9 | Preserve the previous failed validation result while collecting new evidence. |
| RC8 | Corrected packaged documentation and clarified which version had completed the long-running test. |
| RC7 | Identify installation targets by file identity, including directory aliases. |
| RC6 | Scope shutdown during maintenance to the target installation. |
| RC5 | Cache the request ledger by conversation and rebuild changed sessions only. |
| RC4 | Index cumulative fingerprints used to match mirrored request records. |
| RC3 | Display elapsed cycle time as a measured percentage in all languages. |
| RC2 | Improve quota forecasts under coarse readings and recover acquisition from a saved checkpoint. |

