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
	"strings"
)

// Consume opens an SSE connection at url and returns:
//   - events: closed when stream ends or ctx cancels.
//   - errs:   single-receive; nil if stream ended cleanly.
func Consume(ctx context.Context, url string) (<-chan Envelope, <-chan error) {
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
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		var dataLines []string
		for sc.Scan() {
			line := sc.Text()
			if line == "" {
				if len(dataLines) > 0 {
					data := strings.Join(dataLines, "\n")
					var env Envelope
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
