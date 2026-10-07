# Kit gaps

Parts the suite needed that the ui-design kit does not have yet. They live in `apps/shell/src/wos.css`, written with kit tokens only, until the kit takes them (Kit lane). When the kit ships one, delete it here and use the kit class.

| Part | Classes in wos.css | Notes for the kit |
|---|---|---|
| Agent status colours | `--wos-working`, `--wos-needs`, `--wos-blocked`, `--wos-failed`, `--wos-done`, `--wos-idle`, `.wos-status`, `.wos-dot` with `data-status` | Six statuses mapped to accent, warn, a warn and bad mix, bad, good and ink-3. A pulse on working. The ops scheme makes them all grey, which is right for ops; the words carry the meaning. |
| Panels grid | `.wos-grid[data-size=1,2,4,6]`, `.wos-panel`, `.wos-panel-h`, `.wos-panel-f` | A card with a status-coloured top edge, header, scrolling feed and footer actions. Drag to rearrange. |
| Progress and budget bars | `.wos-bar`, `.wos-budget` | Thick plan bar, thin budget bar beneath. |
| Live feed | `.wos-feed`, `.wos-line` | Monospace-free log of messages, tool calls and step lines. |
| Inbox | `.wos-inbox`, `.wos-inbox-list`, `.wos-inbox-detail`, `.wos-answers`, `.wos-reply` | Two columns on a desk, one on a phone. |
| Undo bar | `.wos-undo`, `.wos-undo-bar` | Dark pill with a shrinking line for the two-second undo. |
| Switch | `.wos-switch` | A checkbox switch for app on and off. |
| Model menu | `.wos-picker-btn`, `.wos-menu` | A popover menu that opens up from a composer. |
| Multi-line composer | `.wos-composer` | The kit composer is one line; conversations need a textarea with a toolbar row. |
| Sign-in card | `apps/shell/public/wos-pages.css` (`.wos-gate`) | Centred card for server-drawn pages. |
