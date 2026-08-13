#!/usr/bin/env bash
# Push korean-government-orgchart to public OnAI GitLab (gitlab.aigov.go.kr).
# Token: put PAT (api + write_repository) in ~/.config/glab-cli/aigov-pat.local
# or pass as first arg / env AIGOV_TOKEN. Never commit the token file.
set -euo pipefail

HOST="gitlab.aigov.go.kr"
NS="hosung.seo"
PROJECT="korean-government-orgchart"
PATH_NS="${NS}/${PROJECT}"
API="https://${HOST}/api/v4"
TOKEN_FILE="${HOME}/.config/glab-cli/aigov-pat.local"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

TOKEN="${1:-${AIGOV_TOKEN:-}}"
if [[ -z "${TOKEN}" && -f "${TOKEN_FILE}" ]]; then
  TOKEN="$(tr -d ' \n\r' < "${TOKEN_FILE}")"
fi
if [[ -z "${TOKEN}" ]]; then
  echo "Missing token."
  echo "1) Open https://${HOST}/-/user_settings/personal_access_tokens"
  echo "2) Create token with scopes: api, write_repository"
  echo "3) Save token to: ${TOKEN_FILE}"
  echo "   or: AIGOV_TOKEN=... $0"
  exit 1
fi

auth_hdr=(-H "PRIVATE-TOKEN: ${TOKEN}")

echo "== whoami =="
me="$(curl -fsS "${auth_hdr[@]}" "${API}/user")"
echo "${me}" | python3 -c "import sys,json; u=json.load(sys.stdin); print(u.get('username'), u.get('name'), u.get('web_url'))"

uname="$(echo "${me}" | python3 -c "import sys,json; print(json.load(sys.stdin).get('username',''))")"
if [[ "${uname}" != "${NS}" ]]; then
  echo "WARN: logged in as '${uname}', expected namespace '${NS}'. Using username as namespace."
  NS="${uname}"
  PATH_NS="${NS}/${PROJECT}"
fi

echo "== ensure project ${PATH_NS} =="
# lookup existing
code="$(curl -s -o /tmp/aigov-proj.json -w '%{http_code}' "${auth_hdr[@]}" \
  "${API}/projects/$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PATH_NS}', safe=''))")")"
if [[ "${code}" == "200" ]]; then
  echo "Project exists."
  web="$(python3 -c "import json; print(json.load(open('/tmp/aigov-proj.json')).get('web_url',''))")"
else
  echo "Creating project..."
  curl -fsS "${auth_hdr[@]}" -X POST "${API}/projects" \
    --data-urlencode "name=행정기관 직제 조직도 변환기" \
    --data-urlencode "path=${PROJECT}" \
    --data-urlencode "description=직제·시행규칙 문언 → PPTX · SVG · JSON (공픈클로 / 온AI 연계)" \
    --data-urlencode "visibility=public" \
    --data-urlencode "initialize_with_readme=false" \
    -o /tmp/aigov-proj.json
  web="$(python3 -c "import json; print(json.load(open('/tmp/aigov-proj.json')).get('web_url',''))")"
  echo "Created: ${web}"
fi

http_url="$(python3 -c "import json; print(json.load(open('/tmp/aigov-proj.json')).get('http_url_to_repo',''))")"
if [[ -z "${http_url}" ]]; then
  http_url="https://${HOST}/${PATH_NS}.git"
fi

echo "== glab auth (keyring) =="
printf '%s' "${TOKEN}" | glab auth login --hostname "${HOST}" --stdin --git-protocol https --api-protocol https

cd "${REPO_ROOT}"
if git remote get-url aigov >/dev/null 2>&1; then
  git remote set-url aigov "${http_url}"
else
  git remote add aigov "${http_url}"
fi

echo "== push main =="
# Prefer token in URL only for this push, avoid storing in remote permanently if possible
push_url="https://oauth2:${TOKEN}@${HOST}/${PATH_NS}.git"
git push "${push_url}" "HEAD:main" -u 2>&1 || git push aigov main -u 2>&1

# scrub token from remote url
git remote set-url aigov "https://${HOST}/${PATH_NS}.git"

echo "== verify =="
curl -fsS "${auth_hdr[@]}" \
  "${API}/projects/$(python3 -c "import urllib.parse; print(urllib.parse.quote('${PATH_NS}', safe=''))")" \
  | python3 -c "import sys,json; p=json.load(sys.stdin); print('OK', p.get('web_url'), 'default_branch=', p.get('default_branch'), 'empty=', p.get('empty_repo'))"

echo
echo "Public URL: https://${HOST}/${PATH_NS}"
echo "Done. You can delete ${TOKEN_FILE} after success if desired."
