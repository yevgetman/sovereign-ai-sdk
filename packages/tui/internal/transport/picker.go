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
type PickerItem struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
}

// PickerOpenPayload is the decoded `pickerOpen` side-effect from the
// dispatcher response. On Enter the TUI re-dispatches
// `/<OnSelect.Command> <selected.Value>`.
type PickerOpenPayload struct {
	Title    string       `json:"title"`
	Subtitle string       `json:"subtitle,omitempty"`
	Items    []PickerItem `json:"items"`
	Initial  int          `json:"initial,omitempty"`
	OnSelect struct {
		Command string `json:"command"`
	} `json:"onSelect"`
}
