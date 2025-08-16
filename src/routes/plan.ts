openapi: 3.1.0
info:
  title: Butler API
  version: "1.0.0"
servers:
  - url: https://<your-render-service>.onrender.com
paths:
  /plan:
    post:
      operationId: plan
      summary: Create a safe plan for requested GitHub changes
      security: [{ butlerToken: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [goal, repo]
              properties:
                goal: { type: string, description: "Natural-language request" }
                repo:
                  type: object
                  required: [owner, name]
                  properties:
                    owner: { type: string }
                    name: { type: string }
                baseBranch: { type: string, default: "main" }
      responses:
        "200":
          description: Plan created
  /apply:
    post:
      operationId: apply
      summary: Apply an approved plan as a PR
      security: [{ butlerToken: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [owner, repo, branch, baseBranch, prTitle, edits]
              properties:
                owner: { type: string }
                repo: { type: string }
                branch: { type: string }
                baseBranch: { type: string }
                prTitle: { type: string }
                edits:
                  type: array
                  items:
                    type: object
                    properties:
                      path: { type: string }
                      find: { type: string }
                      replace: { type: string }
                      insertAfter: { type: string }
                      content: { type: string }
                labels:
                  type: array
                  items: { type: string }
                reviewers:
                  type: array
                  items: { type: string }
      responses:
        "200":
          description: PR opened
components:
  securitySchemes:
    butlerToken:
      type: apiKey
      in: header
      name: X-Butler-Token
