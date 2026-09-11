import cliptown_validation
import gleam/dynamic.{type Dynamic}
import gleam/string
import gleeunit
import gleeunit/should

pub fn main() {
  gleeunit.main()
}

fn request_meta(request_id: String, trace_id: String, locale: Dynamic) {
  dynamic.properties([
    #(dynamic.string("requestId"), dynamic.string(request_id)),
    #(dynamic.string("traceId"), dynamic.string(trace_id)),
    #(dynamic.string("locale"), locale),
  ])
}

pub fn request_meta_decoder_accepts_boundaries_test() {
  request_meta(
    string.repeat("r", times: 128),
    string.repeat("t", times: 128),
    dynamic.string(string.repeat("l", times: 64)),
  )
  |> cliptown_validation.decode_request_meta
  |> should.be_ok
}

pub fn request_meta_decoder_rejects_missing_trace_id_test() {
  dynamic.properties([
    #(dynamic.string("requestId"), dynamic.string("req-1")),
  ])
  |> cliptown_validation.decode_request_meta
  |> should.be_error
}

pub fn request_meta_decoder_rejects_oversized_identifier_test() {
  request_meta(
    string.repeat("r", times: 129),
    "trace-1",
    dynamic.string("en"),
  )
  |> cliptown_validation.decode_request_meta
  |> should.be_error
}

pub fn request_meta_decoder_rejects_short_locale_test() {
  request_meta("req-1", "trace-1", dynamic.string("e"))
  |> cliptown_validation.decode_request_meta
  |> should.be_error
}

pub fn request_meta_decoder_rejects_explicit_null_locale_test() {
  request_meta("req-1", "trace-1", dynamic.nil())
  |> cliptown_validation.decode_request_meta
  |> should.be_error
}

pub fn page_query_decoder_checks_bounds_test() {
  dynamic.properties([
    #(dynamic.string("limit"), dynamic.int(1)),
    #(dynamic.string("cursor"), dynamic.string(string.repeat("c", times: 512))),
  ])
  |> cliptown_validation.decode_page_query
  |> should.be_ok

  dynamic.properties([
    #(dynamic.string("limit"), dynamic.int(101)),
  ])
  |> cliptown_validation.decode_page_query
  |> should.be_error
}

pub fn page_query_decoder_requires_limit_test() {
  dynamic.properties([])
  |> cliptown_validation.decode_page_query
  |> should.be_error
}

pub fn problem_details_decoder_checks_status_and_detail_test() {
  dynamic.properties([
    #(dynamic.string("type"), dynamic.string("urn:test")),
    #(dynamic.string("title"), dynamic.string("Invalid request")),
    #(dynamic.string("status"), dynamic.int(599)),
    #(dynamic.string("detail"), dynamic.string(string.repeat("d", times: 4096))),
    #(dynamic.string("requestId"), dynamic.string("req-1")),
  ])
  |> cliptown_validation.decode_problem_details
  |> should.be_ok

  dynamic.properties([
    #(dynamic.string("type"), dynamic.string("urn:test")),
    #(dynamic.string("title"), dynamic.string("Invalid request")),
    #(dynamic.string("status"), dynamic.int(600)),
    #(dynamic.string("requestId"), dynamic.string("req-1")),
  ])
  |> cliptown_validation.decode_problem_details
  |> should.be_error
}
