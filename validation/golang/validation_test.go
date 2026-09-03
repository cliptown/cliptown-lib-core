package validation

import (
	"strings"
	"testing"
)

func TestPublicBoundaries(t *testing.T) {
	for _, value := range []RequestMeta{{RequestID: "req-1", TraceID: "trace-1"}, {RequestID: strings.Repeat("r", 128), TraceID: strings.Repeat("t", 128), Locale: strings.Repeat("l", 64)}} { if err := Validate(value); err != nil { t.Fatal(err) } }
	for _, value := range []RequestMeta{{TraceID: "trace-1"}, {RequestID: strings.Repeat("r", 129), TraceID: "trace-1"}, {RequestID: "req-1", TraceID: "trace-1", Locale: "e"}} { if err := Validate(value); err == nil { t.Fatalf("expected invalid request: %#v", value) } }
	for _, value := range []PageQuery{{Limit: 1}, {Limit: 100, Cursor: strings.Repeat("c", 512)}} { if err := Validate(value); err != nil { t.Fatal(err) } }
	for _, value := range []PageQuery{{Limit: 0}, {Limit: 101}, {Limit: 50, Cursor: strings.Repeat("c", 513)}} { if err := Validate(value); err == nil { t.Fatalf("expected invalid page query: %#v", value) } }
	problem := ProblemDetails{Type: "urn:test", Title: "bad", Status: 400, RequestID: "req-1"}; if err := Validate(problem); err != nil { t.Fatal(err) }; problem.Status = 600; if err := Validate(problem); err == nil { t.Fatal("expected invalid status") }
}

func TestDecodeRejectsUnknownMissingAndTrailingData(t *testing.T) {
	for _, data := range [][]byte{[]byte(`{"requestId":"req-1","traceId":"trace-1","userId":"client-supplied"}`), []byte(`{"requestId":"req-1"}`), []byte(`{"requestId":"req-1","traceId":"trace-1"} {"requestId":"req-2","traceId":"trace-2"}`)} { if _, err := DecodeAndValidate[RequestMeta](data); err == nil { t.Fatalf("expected decode failure: %s", data) } }
}

func TestDecodePreservesIdentifierText(t *testing.T) { value, err := DecodeAndValidate[RequestMeta]([]byte(`{"requestId":" req-1 ","traceId":" trace-1 "}`)); if err != nil { t.Fatal(err) }; if value.RequestID != " req-1 " || value.TraceID != " trace-1 " { t.Fatalf("normalized: %#v", value) } }
