-module(cliptown_locks_test).
-compile([no_auto_import, nowarn_unused_vars, nowarn_unused_function, nowarn_nomatch, inline]).
-define(FILEPATH, "test/cliptown_locks_test.gleam").
-export([main/0, keys_carry_the_org_prefix_test/0, placeholders_are_filled_in_order_test/0]).

-file("test/cliptown_locks_test.gleam", 6).
-spec main() -> nil.
main() ->
    gleeunit:main().

-file("test/cliptown_locks_test.gleam", 10).
-spec keys_carry_the_org_prefix_test() -> nil.
keys_carry_the_org_prefix_test() ->
    Key@1 = case cliptown_locks:key(jobs, <<"x"/utf8>>) of
        {ok, Key} -> Key;
        _assert_fail ->
            erlang:error(#{gleam_error => let_assert,
                        message => <<"Pattern match failed, no pattern matched the value."/utf8>>,
                        file => <<?FILEPATH/utf8>>,
                        module => <<"cliptown_locks_test"/utf8>>,
                        function => <<"keys_carry_the_org_prefix_test"/utf8>>,
                        line => 11,
                        value => _assert_fail,
                        start => 194,
                        'end' => 249,
                        pattern_start => 205,
                        pattern_end => 212})
    end,
    _pipe = ores_locks_and_leases:key_to_string(Key@1),
    gleeunit@should:equal(_pipe, <<"cliptown/jobs/x"/utf8>>).

-file("test/cliptown_locks_test.gleam", 15).
-spec placeholders_are_filled_in_order_test() -> nil.
placeholders_are_filled_in_order_test() ->
    Entry = {entry,
        jobs,
        <<"{a}/x/{b}"/utf8>>,
        {layers, true, true},
        transaction,
        true},
    Key@1 = case cliptown_locks:entry_key(Entry, [<<"1"/utf8>>, <<"2"/utf8>>]) of
        {ok, Key} -> Key;
        _assert_fail ->
            erlang:error(#{gleam_error => let_assert,
                        message => <<"Pattern match failed, no pattern matched the value."/utf8>>,
                        file => <<?FILEPATH/utf8>>,
                        module => <<"cliptown_locks_test"/utf8>>,
                        function => <<"placeholders_are_filled_in_order_test"/utf8>>,
                        line => 24,
                        value => _assert_fail,
                        start => 548,
                        'end' => 607,
                        pattern_start => 559,
                        pattern_end => 566})
    end,
    _pipe = ores_locks_and_leases:key_to_string(Key@1),
    gleeunit@should:equal(_pipe, <<"cliptown/jobs/1/x/2"/utf8>>),
    _pipe@1 = cliptown_locks:catalog_is_well_formed(),
    gleeunit@should:be_true(_pipe@1).
