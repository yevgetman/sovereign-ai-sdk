// Package transport — M11.5 wire types for the inline picker card.
// Mirrors `PickerOpenConfig` in `src/server/schema.ts` (the canonical
// source for the dispatcher's side-effect envelope). The server emits
// `sideEffects.pickerOpen` on the response to `/model`, `/resume`, and
// `/export` when invoked with no args; the TUI decodes the payload
// into these structs and feeds them to the PickerCard component.
//
// Struct tags MUST match the JSON wire shape exactly. ADR M11.5-01.

package transport

// PickerItem is a single selectable entry shown in the picker card.
// `Hint` is rendered dim next to the label when present.
//
// 2026-05-24 — config UX rebuild. `ValueColumn` and `Badge` extend the
// shape so the same component can render config submenu rows. When
// neither is set the row layout matches the M11.5 baseline (label +
// optional hint), so /model, /resume, /export, /theme stay byte-
// identical visually.
//
// Badge is one of the four apply-scope tokens (2026-06-14 config
// live-apply): `"live"` / `"reload"` render a green "applied" pill,
// `"other"` / `"restart"` an amber "saved, not applied here" pill.
// Other values render no badge. See PickerCard.renderBadge.
type PickerItem struct {
	Label       string `json:"label"`
	Value       string `json:"value"`
	Hint        string `json:"hint,omitempty"`
	ValueColumn string `json:"valueColumn,omitempty"`
	Badge       string `json:"badge,omitempty"`
}

// PickerOpenPayload is the decoded `pickerOpen` side-effect from the
// dispatcher response. On Enter the TUI re-dispatches
// `/<OnSelect.Command> <selected.Value>`.
//
// 2026-05-24 patch — `OnBack` (optional) carries the command to re-
// dispatch when the user hits backspace inside the picker so they
// can navigate back to the previous menu without re-running /config.
// Absence means no parent (root menu, or any non-hierarchical
// picker like /model / /resume / /export / /theme), so backspace
// is a no-op. Esc still cancels outright.
type PickerOpenPayload struct {
	Title    string       `json:"title"`
	Subtitle string       `json:"subtitle,omitempty"`
	Items    []PickerItem `json:"items"`
	Initial  int          `json:"initial,omitempty"`
	OnSelect struct {
		Command string `json:"command"`
	} `json:"onSelect"`
	OnBack *struct {
		Command string `json:"command"`
	} `json:"onBack,omitempty"`
	// 2026-05-24 patch — save & exit. Dispatched on the `S` key when
	// present (used by /config draft-edit pickers). Absent on pickers
	// that don't need an explicit save (/model, /resume, /export,
	// /theme — already atomic).
	OnSave *struct {
		Command string `json:"command"`
	} `json:"onSave,omitempty"`
	// 2026-05-24 patch — cancel & exit. Dispatched on `Esc` when
	// present (used by /config draft-edit pickers to discard the
	// draft). When absent, Esc falls back to the back-nav-or-close
	// path.
	OnCancel *struct {
		Command string `json:"command"`
	} `json:"onCancel,omitempty"`
}
