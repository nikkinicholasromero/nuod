# nuod working agreement

For every user change request, follow this complete workflow without waiting for the user to restate it:

1. Think through the requested outcome and inspect the relevant code before editing.
2. State a short, concrete implementation plan in a commentary update.
3. Implement the smallest clean solution that fully addresses the request. Keep nuod a simple static site unless the request clearly requires otherwise.
4. Test the changed behavior locally. For UI work, verify the relevant desktop and/or mobile interaction in a browser; for code changes, check for errors appropriate to the change.
5. Fix any issue found during testing, then retest.
6. Commit all completed work with a concise, meaningful Git commit message. Do not commit unrelated files or secrets.
7. Deploy the resulting revision to the existing `nuod` Vercel production project using `vercel.cmd --prod --yes`.
8. Confirm the final result to the user with the deployment URL and commit hash.

Keep user-facing updates brief, say what is changing and why, and surface blockers as soon as they are known.
