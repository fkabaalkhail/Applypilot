/**
 * Display names for the backend's canonical skill tags
 * (structured_extraction._SKILL_SYNONYMS keys, all lowercase).
 */
const SPECIAL: Record<string, string> = {
  sql: "SQL", html: "HTML", css: "CSS", aws: "AWS", gcp: "GCP", php: "PHP",
  "c++": "C++", "c#": "C#", ".net": ".NET", "ci/cd": "CI/CD", "tcp/ip": "TCP/IP",
  nlp: "NLP", llm: "LLMs", etl: "ETL", dbt: "dbt", ios: "iOS", ui: "UI", ux: "UX",
  qa: "QA", seo: "SEO", sap: "SAP", cad: "CAD", plc: "PLC", fpga: "FPGA",
  vhdl: "VHDL", grpc: "gRPC", rest: "REST", graphql: "GraphQL", matlab: "MATLAB",
  mysql: "MySQL", postgresql: "PostgreSQL", mongodb: "MongoDB", dynamodb: "DynamoDB",
  bigquery: "BigQuery", javascript: "JavaScript", typescript: "TypeScript",
  "node.js": "Node.js", "next.js": "Next.js", pytorch: "PyTorch", tensorflow: "TensorFlow",
  "scikit-learn": "scikit-learn", numpy: "NumPy", "power bi": "Power BI",
  autocad: "AutoCAD", solidworks: "SolidWorks", "objective-c": "Objective-C",
  cloudformation: "CloudFormation", rabbitmq: "RabbitMQ", fastapi: "FastAPI",
  jira: "Jira", unix: "Unix", r: "R", go: "Go",
};

export function skillLabel(tag: string): string {
  const key = tag.trim().toLowerCase();
  if (SPECIAL[key]) return SPECIAL[key];
  return key.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
}
