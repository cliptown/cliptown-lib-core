import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/option.{type Option, None, Some}
import gleam/string

pub const contract_version = "ores.validation.v1"

pub type RequestMeta {
  RequestMeta(request_id: String, trace_id: String, locale: Option(String))
}

pub type PageQuery {
  PageQuery(limit: Int, cursor: Option(String))
}

pub type ProblemDetails {
  ProblemDetails(
    type_: String,
    title: String,
    status: Int,
    detail: Option(String),
    request_id: String,
  )
}

pub fn request_meta_decoder() -> decode.Decoder(RequestMeta) {
  use request_id <- decode.field("requestId", bounded_string(1, 128))
  use trace_id <- decode.field("traceId", bounded_string(1, 128))
  use locale <- decode.optional_field(
    "locale",
    None,
    bounded_string(2, 64)
    |> decode.map(fn(value) { Some(value) }),
  )
  decode.success(RequestMeta(request_id: request_id, trace_id: trace_id, locale: locale))
}

pub fn page_query_decoder() -> decode.Decoder(PageQuery) {
  use limit <- decode.field("limit", bounded_int(1, 100))
  use cursor <- decode.optional_field(
    "cursor",
    None,
    bounded_string(1, 512)
    |> decode.map(fn(value) { Some(value) }),
  )
  decode.success(PageQuery(limit: limit, cursor: cursor))
}

pub fn problem_details_decoder() -> decode.Decoder(ProblemDetails) {
  use type_ <- decode.field("type", bounded_string(1, 512))
  use title <- decode.field("title", bounded_string(1, 256))
  use status <- decode.field("status", bounded_int(400, 599))
  use detail <- decode.optional_field(
    "detail",
    None,
    bounded_string(0, 4096)
    |> decode.map(fn(value) { Some(value) }),
  )
  use request_id <- decode.field("requestId", bounded_string(1, 128))
  decode.success(ProblemDetails(type_: type_, title: title, status: status, detail: detail, request_id: request_id))
}

pub fn decode_request_meta(value: Dynamic) {
  decode.run(value, request_meta_decoder())
}

pub fn decode_page_query(value: Dynamic) {
  decode.run(value, page_query_decoder())
}

pub fn decode_problem_details(value: Dynamic) {
  decode.run(value, problem_details_decoder())
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

fn bounded_int(min: Int, max: Int) -> decode.Decoder(Int) {
  decode.int
  |> decode.then(fn(value) {
    case value >= min && value <= max {
      True -> decode.success(value)
      False -> decode.failure(0, expected: "bounded Int")
    }
  })
}
