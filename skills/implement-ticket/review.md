# Address a review

The owner reviewed the PR and requested changes. Each unresolved thread gets a
reply this round. Resolving a thread is the owner's way of accepting it, so
leave every thread open.

## 1. Read

```bash
gh pr checkout <pr>
gh pr view <pr> --comments
gh api graphql -F owner='{owner}' -F name='{repo}' -F n=<pr> -f query='
  query($owner: String!, $name: String!, $n: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $n) {
        reviewThreads(first: 100) {
          nodes { isResolved path line
            comments(first: 20) { nodes { databaseId author { login } body } } }
        }
      }
    }
  }'
```

Then read the issue the PR closes, as in step 1 of the skill.

## 2. Answer each unresolved thread

- If it changes the ticket's *Interface* or *Done when*, leave the code as it is
  and reply that the ticket needs amending. The owner amends the ticket or opens
  a follow-up.
- If you agree, fix it in a new commit and reply with the commit's short SHA.
- If you disagree, reply with the reason.

Fixes go on top as new commits. The owner reviews only what changed since the
last review, so the pushed history stays as it is.

Reply in a thread with:

```bash
gh api -f body="..." \
  repos/{owner}/{repo}/pulls/<pr>/comments/<databaseId>/replies
```

Answer comments on the PR as a whole with `gh pr comment <pr>`.

## 3. Push

Push the branch. If the fixes changed the attention level, *Your call*, *At a
glance*, which test proves a *Done when* item, a GUI state, or the blast radius,
update those parts of the PR body (`gh pr edit <pr> --body-file`), the label
(`gh pr edit <pr> --remove-label <old> --add-label <new>`), and the screenshots
as in step 5 of the skill.

Done when every unresolved thread has a reply from this round and the branch is
pushed.
