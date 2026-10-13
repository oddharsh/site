# aadhar

aadhar.sh from the terminal. Every command is one GET against the site's
keyless public API, described at <https://aadhar.sh/openapi.json>. No key, no
account, no dependencies; Node 18 or later.

```sh
npx aadhar-sh search fhe
npx aadhar-sh ask "how does the site sign its requests"
npx aadhar-sh read /lwe/fhe
npx aadhar-sh photos --recipe DR400 --limit 5
npx aadhar-sh lens example.com
npx aadhar-sh playing
npx aadhar-sh coffee
```

Add `--json` to any command for the endpoint's raw JSON. The guide is at
<https://aadhar.sh/developers>.
