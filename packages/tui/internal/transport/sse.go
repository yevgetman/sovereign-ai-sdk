// Package transport — SSE consumer.
//
// Connects to GET <url>, parses standard `event: <type>\nid: <seq>\ndata: <json>\n\n`
// blocks, and emits typed Envelopes on a channel. Closes the channel when
// the server ends the response or ctx is cancelled. Errors (HTTP, parse) are
// surfaced on errCh after the events channel closes.

package transport

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
)

// Consume opens an SSE connection at url and returns:
//   - events: closed when stream ends or ctx cancels.
//   - errs:   single-receive; nil if stream ended cleanly.
//
// lastEventID is the highest event seq the caller has already seen. When > 0 it
// is sent as the standard `Last-Event-ID` header so the server replays only
// events AFTER it. This is what makes reconnect-after-a-turn safe: without it a
// reconnect is a fresh (no-cursor) subscriber and the server replays the whole
// just-completed turn — including its turn_complete — which ends the stream
// again, so the client reconnects and re-receives it forever (an infinite loop
// that re-streams the same assistant turn). Pass 0 for the first connection.
func Consume(ctx context.Context, url string, lastEventID int64) (<-chan Envelope, <-chan error) {
	events := make(chan Envelope, 16)
	errs := make(chan error, 1)

	go func() {
		defer close(events)
		defer close(errs)

		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			errs <- fmt.Errorf("new request: %w", err)
			return
		}
		req.Header.Set("Accept", "text/event-stream")
		if lastEventID > 0 {
			req.Header.Set("Last-Event-ID", strconv.FormatInt(lastEventID, 10))
		}

		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			errs <- fmt.Errorf("http do: %w", err)
			return
		}
		defer resp.Body.Close()

		if resp.StatusCode != http.StatusOK {
			errs <- fmt.Errorf("unexpected status %d", resp.StatusCode)
			return
		}

		sc := bufio.NewScanner(resp.Body)
		// A single SSE `data:` line carries a whole event — including a
		// tool_result whose content can be a full FileRead (capped at 1 MiB).
		// JSON-encoded + framed that exceeds the old 1 MiB token cap, which made
		// Scan() fail with bufio.ErrTooLong and killed the stream mid-turn. 16
		// MiB gives ample headroom for any realistic single event while still
		// bounding memory.
		sc.Buffer(make([]byte, 64*1024), 16<<20)
		var dataLines []string
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					var env Envelope
					// Malformed envelopes are intentionally dropped silently —
					// log.Printf would corrupt the Bubble Tea alt-screen
					// renderer. M4+ should add a packages/tui/internal/log
					// debug-log sink for diagnostics. Until then, the TS-side
					// Zod schema lockstep is assumed to prevent real-world
					// malformed events; the silent drop is the lesser evil.
					if err := json.Unmarshal([]byte(data), &env); err == nil {
						select {
						case <-ctx.Done():
							errs <- ctx.Err()
							return
						case events <- env:
						}
					}
					dataLines = dataLines[:0]
				}
				continue
			}
			if strings.HasPrefix(line, "data: ") {
				dataLines = append(dataLines, strings.TrimPrefix(line, "data: "))
			}
			// event: and id: lines are advisory; the JSON payload carries them.
		}
		if err := sc.Err(); err != nil {
			errs <- fmt.Errorf("scanner: %w", err)
		}
	}()

	return events, errs
}
