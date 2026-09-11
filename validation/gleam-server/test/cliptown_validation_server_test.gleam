import cliptown_validation_server
import gleam/dynamic.{type Dynamic}
import gleam/string
import gleeunit
import gleeunit/should

pub fn main() {
  gleeunit.main()
}

fn repeat_dynamic(value: Dynamic, times: Int) -> List(Dynamic) {
  case times {
    0 -> []
    _ -> [value, ..repeat_dynamic(value, times - 1)]
  }
}

fn actor(user_id: String, roles: List(Dynamic)) {
  dynamic.properties([
    #(dynamic.string("userId"), dynamic.string(user_id)),
    #(dynamic.string("roles"), dynamic.list(roles)),
  ])
}

fn public_meta() {
  dynamic.properties([
    #(dynamic.string("requestId"), dynamic.string("req-1")),
    #(dynamic.string("traceId"), dynamic.string("trace-1")),
  ])
}

fn context(source_ip: Dynamic) {
  dynamic.properties([
    #(dynamic.string("public"), public_meta()),
    #(dynamic.string("actor"), actor("user-1", [dynamic.string("reader")])),
    #(dynamic.string("sourceIp"), source_ip),
  ])
}

pub fn trusted_actor_decoder_accepts_boundaries_test() {
  actor("user-1", [dynamic.string(string.repeat("r", times: 128))])
  |> cliptown_validation_server.decode_trusted_actor
  |> should.be_ok
}

pub fn trusted_actor_decoder_rejects_empty_user_test() {
  actor("", [])
  |> cliptown_validation_server.decode_trusted_actor
  |> should.be_error
}

pub fn trusted_actor_decoder_rejects_too_many_roles_test() {
  actor("user-1", repeat_dynamic(dynamic.string("reader"), 65))
  |> cliptown_validation_server.decode_trusted_actor
  |> should.be_error
}

pub fn server_context_decoder_rejects_invalid_source_ip_test() {
  context(dynamic.string("not-an-ip"))
  |> cliptown_validation_server.decode_server_request_context
  |> should.be_error
}

pub fn server_context_decoder_rejects_null_source_ip_test() {
  context(dynamic.nil())
  |> cliptown_validation_server.decode_server_request_context
  |> should.be_error
}

pub fn internal_command_decoder_checks_required_operation_test() {
  dynamic.properties([
    #(dynamic.string("operationId"), dynamic.string("clips.create")),
    #(dynamic.string("context"), context(dynamic.string("127.0.0.1"))),
    #(dynamic.string("payload"), dynamic.properties([])),
  ])
  |> cliptown_validation_server.decode_internal_command
  |> should.be_ok

  dynamic.properties([
    #(dynamic.string("operationId"), dynamic.string("")),
    #(dynamic.string("context"), context(dynamic.string("127.0.0.1"))),
    #(dynamic.string("payload"), dynamic.properties([])),
  ])
  |> cliptown_validation_server.decode_internal_command
  |> should.be_error
}
