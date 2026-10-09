fn main() {
    // An AI tool starts Mark's binary as its MCP server: the bridge, which
    // relays to the running app and never becomes one itself.
    if std::env::args().nth(1).as_deref() == Some("--mcp") { std::process::exit(mark_lib::mcp::serve_stdio()); }
    mark_lib::run();
}
