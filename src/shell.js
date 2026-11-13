import { createSession } from "./shell/session.js";

// The shell behind the terminal. It is a separate script because the bash
// interpreter is several times the size of everything else on the page;
// terminal.js starts the login animation at once and picks this up when it
// arrives.
window.__createShell = createSession;
