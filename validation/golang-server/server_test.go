package servervalidation

import (
	"strings"
	"testing"
	public "github.com/cliptown/cliptown-lib-core/validation/golang"
)

func validContext() ServerRequestContext { return ServerRequestContext{Public: public.RequestMeta{RequestID: "req-1", TraceID: "trace-1"}, Actor: TrustedActor{UserID: "user-1", Roles: []string{"reader"}}, SourceIP: "127.0.0.1"} }
func TestServerBoundaries(t *testing.T) { if err := Validate(validContext()); err != nil { t.Fatal(err) }; if err := Validate(InternalCommand{OperationID: "clips.create", Context: validContext()}); err != nil { t.Fatal(err) }; for _, actor := range []TrustedActor{{UserID: ""}, {UserID: strings.Repeat("u", 129)}, {UserID: "user-1", Roles: []string{""}}, {UserID: "user-1", Roles: make([]string, 65)}} { if err := Validate(actor); err == nil { t.Fatalf("expected invalid actor: %#v", actor) } }; value := validContext(); value.SourceIP = "not-an-ip"; if err := Validate(value); err == nil { t.Fatal("expected invalid IP") }; if err := Validate(InternalCommand{OperationID: "", Context: validContext()}); err == nil { t.Fatal("expected invalid operation") } }
