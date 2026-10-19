import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from "n8n-workflow";

export class RecallApi implements ICredentialType {
  name = "recallApi";

  displayName = "Recall API";

  icon = "file:../nodes/Recall/recall.svg" as const;

  documentationUrl = "https://recallmem.dev/guides/n8n";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "A Recall API key. Create one at https://app.recallmem.dev/keys ($5 of free credit, no card). Leave empty for a self-hosted server without authentication.",
    },
    {
      displayName: "Workspace",
      name: "workspace",
      type: "string",
      default: "default",
      description:
        "The Recall workspace to keep memory in. Use one per app, so two apps never share what they know about a person.",
    },
    {
      displayName: "Base URL",
      name: "baseUrl",
      type: "string",
      default: "https://api.recallmem.dev",
      description: "Change it only for a self-hosted Recall server.",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: {
        Authorization: '={{$credentials.apiKey ? "Bearer " + $credentials.apiKey : ""}}',
      },
    },
  };

  // Gets or creates the workspace: the one call any valid key may make, and the first one a node makes.
  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "")}}',
      url: "/v3/workspaces",
      method: "POST",
      body: { id: "={{$credentials.workspace}}" },
    },
  };
}
