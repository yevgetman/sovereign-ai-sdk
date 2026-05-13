package app

import "github.com/charmbracelet/bubbles/key"

type keyMap struct {
	Quit key.Binding
}

func defaultKeys() keyMap {
	return keyMap{
		Quit: key.NewBinding(
			key.WithKeys("esc", "ctrl+c"),
			key.WithHelp("esc/ctrl+c", "quit"),
		),
	}
}
