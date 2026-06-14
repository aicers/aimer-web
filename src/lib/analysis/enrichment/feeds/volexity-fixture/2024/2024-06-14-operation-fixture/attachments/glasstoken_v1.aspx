<%-- Volexity fixture sentinel — a live web-shell SOURCE under attachments/ that
     the allowlist must NEVER fetch. If the engine ever reads this file, the
     binary/attachment-skip guard has regressed. It deliberately contains a
     domain-shaped token that must not appear in the snapshot:
     webshell.should-never-be-fetched.test --%>
<%@ Page Language="C#" %>
<% Response.Write("volexity fixture web-shell — never parsed"); %>
