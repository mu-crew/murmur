# Roadmap

Candidates with a known shape but no release yet. Delete a row when it ships.

| Item | Gap today | Shape | Size |
| --- | --- | --- | --- |
| **Telemetry on `PaneView`** | `PaneView` carries no model, effort or context use, so mural casts it to its own `PaneTelemetryExt` (`src/server/projector.ts`) to show a telemetry strip. | Add optional `model`, `effort` and `context` fields, read from the harness's OSC 7501 records or the session tail (OSC 7501 all-in spec §4.4); unknown stays absent. mural then drops its cast. Low value until a consumer needs more than mural's strip. | ~1 day |
| **Test coverage follow-up** | The 3.1 release review listed coverage gaps without bugs: remote Rex jump, steer and glance; `readStatus` and pane-process edge branches; `stop`'s Rex `idle`/`gone` branches; a duplicated test helper in the pane tests. Some crash-suppression tests pass whether or not the code under test honours its input (fixtures default to an orchestrated implementer). | Add the missing branch tests, make the crash-suppression fixtures discriminate, consolidate the helpers. | ~1 day |
