# Changelog

## 0.1.22

- pin the container base image by digest and constrain Alpine Python/uv versions to keep pod startup stable

## 0.1.21

- fix dbt CLI argument ordering by placing subcommands before project/profile flags
- strip ANSI terminal sequences before extracting `dbt show --output json` payloads

## 0.1.19

- increase the default artifact inline limit to 5 MB and mark attached `.csv` files as `text/csv` for Slack uploads

## 0.1.18

- make `attach` the only built-in tool that emits attachment artifacts; `chart` now only writes PNG files for explicit attachment
- defer emitted artifacts until after the final assistant text so images arrive after the answer

## 0.1.17

- install DejaVu/fontconfig in the container image so Chart.js text rendering shows axis labels, ticks, titles, and data labels in generated PNG artifacts

## 0.1.16

- render chart artifacts with an explicit white PNG background
- show X/Y axis labels by default, deriving readable labels from field names when labels are not provided
- show data value labels on charts by default, with `dataLabels: false` available as an opt-out

## 0.1.14

- upgrade pi runtime packages to `0.73.0` and adapt worker integration to the updated APIs
- preserve session restore, auth/model lookup, and compaction event handling with the newer pi runtime
- add dbt prod-target guidance and bootstrap support for analytics deployments

## 0.1.12

- emit only the final assistant answer to the gateway and suppress internal thinking output

## 0.1.11

- add `BEE_PI_AGENT_THINKING_LEVEL` support for configuring model reasoning level, including `medium`
- suppress empty assistant thinking events so downstream consumers only receive non-blank thinking output
- document `BEE_PI_AGENT_THINKING_LEVEL` in the README

## 0.1.8

- rename Helm chart packaging from `charts/bee-pi-agent` to `charts/fabee-pi-agent`
- rename Helm helper namespaces from `bee-pi-agent.*` to `fabee-pi-agent.*`
- add optional `dbtProfiles` secret mount support to the Helm chart for mounting `profiles.yml`
- update README to reference the renamed Helm chart packaging while keeping runtime naming compatibility notes

## 0.1.0-jmm.0

- initial extraction of a generic HTTP-operated worker runtime from `pi-mom`
- removes Slack-specific ingress/response handling
- exposes a run-oriented SSE API for gateway integration
