{application, cliptown_locks, [
    {vsn, "0.1.0"},
    {applications, [gleam_stdlib,
                    gleeunit,
                    ores_locks_and_leases]},
    {description, "cliptown lock routines: ores_locks_and_leases with the cliptown key prefix and lock catalog."},
    {modules, [cliptown_locks_test]},
    {registered, []}
]}.
