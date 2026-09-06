import cliptown_validation.{type RequestMeta}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/string

pub type TrustedActor {
  TrustedActor(user_id: String, tenant_id: Option(String), roles: List(String))
}

pub type ServerRequestContext {
  ServerRequestContext(
    public: RequestMeta,
    actor: TrustedActor,
    source_ip: Option(String),
  )
}

pub type InternalCommand {
  InternalCommand(
    operation_id: String,
    idempotency_key: Option(String),
    context: ServerRequestContext,
    payload: Dynamic,
  )
}

pub fn trusted_actor_decoder() -> decode.Decoder(TrustedActor) {
  use user_id <- decode.field("userId", bounded_string(1, 128))
  use tenant_id <- decode.optional_field(
    "tenantId",
    None,
    bounded_string(1, 128)
    |> decode.map(fn(value) { Some(value) }),
  )
  use roles <- decode.field("roles", roles_decoder())
  decode.success(TrustedActor(user_id: user_id, tenant_id: tenant_id, roles: roles))
}

pub fn server_request_context_decoder() -> decode.Decoder(ServerRequestContext) {
  use public <- decode.field(
    "public",
    cliptown_validation.request_meta_decoder(),
  )
  use actor <- decode.field("actor", trusted_actor_decoder())
  use source_ip <- decode.optional_field(
    "sourceIp",
    None,
    ip_string()
    |> decode.map(fn(value) { Some(value) }),
  )
  decode.success(ServerRequestContext(public: public, actor: actor, source_ip: source_ip))
}

pub fn internal_command_decoder() -> decode.Decoder(InternalCommand) {
  use operation_id <- decode.field("operationId", bounded_string(1, 256))
  use idempotency_key <- decode.optional_field(
    "idempotencyKey",
    None,
    bounded_string(1, 128)
    |> decode.map(fn(value) { Some(value) }),
  )
  use context <- decode.field("context", server_request_context_decoder())
  use payload <- decode.field("payload", decode.dynamic)
  decode.success(InternalCommand(
    operation_id: operation_id,
    idempotency_key: idempotency_key,
    context: context,
    payload: payload,
  ))
}

pub fn decode_trusted_actor(value: Dynamic) {
  decode.run(value, trusted_actor_decoder())
}

pub fn decode_server_request_context(value: Dynamic) {
  decode.run(value, server_request_context_decoder())
}

pub fn decode_internal_command(value: Dynamic) {
  decode.run(value, internal_command_decoder())
}

fn bounded_string(min: Int, max: Int) -> decode.Decoder(String) {
  decode.string
  |> decode.then(fn(value) {
    let length = string.length(value)
    case length >= min && length <= max {
      True -> decode.success(value)
      False -> decode.failure("", expected: "bounded String")
    }
  })
}

fn roles_decoder() -> decode.Decoder(List(String)) {
  decode.list(bounded_string(1, 128))
  |> decode.then(fn(roles) {
    case list.length(roles) <= 64 {
      True -> decode.success(roles)
      False -> decode.failure([], expected: "at most 64 bounded roles")
    }
  })
}

fn ip_string() -> decode.Decoder(String) {
  bounded_string(2, 45)
  |> decode.then(fn(value) {
    case string.contains(value, ".") || string.contains(value, ":") {
      True -> decode.success(value)
      False -> decode.failure("", expected: "IP address")
    }
  })
}
