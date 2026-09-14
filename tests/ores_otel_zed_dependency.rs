fn dependency_value<'a>(manifest: &'a str, key: &str) -> Option<&'a str> {
    let mut in_dependencies = false;
    for raw_line in manifest.lines() {
        let line = raw_line.trim();
        if line == "[dependencies]" {
            in_dependencies = true;
            continue;
        }
        if in_dependencies && line.starts_with('[') {
            break;
        }
        if !in_dependencies || line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (candidate, value) = line.split_once('=')?;
        if candidate.trim().trim_matches('"') == key {
            return Some(value.trim().trim_matches('"'));
        }
    }
    None
}

#[test]
fn canonical_ores_otel_logger_is_a_zed_dependency() {
    let manifest = include_str!("../.zpkg.toml");
    assert_eq!(
        dependency_value(manifest, "oresoftware/next-loggers"),
        Some("^0.1.0"),
        "the canonical next-loggers package from ores-otel/ores.otel.log must remain a direct Zed dependency",
    );
}
