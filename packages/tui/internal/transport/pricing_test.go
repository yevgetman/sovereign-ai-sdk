package transport

import (
	"encoding/json"
	"testing"
)

func TestSessionPricingCompletenessRetainsUnknownAndLegacyStates(t *testing.T) {
	for _, raw := range []string{
		`{"input":1,"output":2,"estimatedCostUsd":0,"costComplete":false}`,
		`{"input":1,"output":2,"estimatedCostUsd":1.2,"costComplete":true}`,
		`{"input":1,"output":2,"estimatedCostUsd":0}`,
	} {
		var tokens SessionTokens
		if err := json.Unmarshal([]byte(raw), &tokens); err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(tokens)
		if err != nil {
			t.Fatal(err)
		}
		var fields map[string]any
		if err := json.Unmarshal(encoded, &fields); err != nil {
			t.Fatal(err)
		}
		var original map[string]any
		if err := json.Unmarshal([]byte(raw), &original); err != nil {
			t.Fatal(err)
		}
		want, exists := original["costComplete"]
		got, present := fields["costComplete"]
		if exists != present || want != got {
			t.Fatalf("completeness changed: %s", encoded)
		}
	}
}
