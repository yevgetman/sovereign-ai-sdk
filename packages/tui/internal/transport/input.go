// Package transport — 2026-05-24 (config UX rebuild) wire type for the
// inline InputCard. Parallel to PickerOpenPayload but for free-text
// edits (string, number, secret).
//
// Mirrors `InputOpenConfig` in `src/server/schema.ts`. The server emits
// `sideEffects.inputOpen` from `/config edit <dotpath>` when the
// catalog item's editor kind is `string` | `number` | `secret`. The
// TUI decodes the payload into this struct and feeds it to the
// InputCard component; on Enter the typed value is re-dispatched as
// `/<OnSubmit.Command> <value>`.
//
// Struct tags MUST match the JSON wire shape exactly.

package transport

// InputOpenPayload is the decoded `inputOpen` side-effect from the
// dispatcher response.
//
// `Initial` is the current value (pre-populated into the text input).
// `Placeholder` shows when Initial is empty. `Masked` toggles
// EchoPassword in the textinput component (API keys, secrets).
type InputOpenPayload struct {
	Title       string `json:"title"`
	Subtitle    string `json:"subtitle,omitempty"`
	Initial     string `json:"initial,omitempty"`
	Placeholder string `json:"placeholder,omitempty"`
	Masked      bool   `json:"masked,omitempty"`
	OnSubmit    struct {
		Command string `json:"command"`
	} `json:"onSubmit"`
	// OnBack — when present, Esc closes the input card and re-
	// dispatches this command (back-navigation). When absent, Esc
	// closes the card outright (with a "(cancelled)" marker in
	// scrollback). Symmetric with PickerOpenPayload.OnBack.
	// 2026-05-24 patch.
	OnBack *struct {
		Command string `json:"command"`
	} `json:"onBack,omitempty"`
}
