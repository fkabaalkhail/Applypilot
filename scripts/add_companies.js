const fs = require('fs');
const d = JSON.parse(fs.readFileSync('frontend/src/data/interview-questions.json', 'utf8'));

const more = [
  {
    name: "CIBC", domain: "cibc.com", category: "Canadian", totalQuestions: 14,
    questions: [
      { title: "Design a Secure Authentication System for Banking", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Hash Map", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Tell me about a time you improved customer experience", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Mortgage Calculator API", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Coin Change (Dynamic Programming)", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Design a Branch Locator Service", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Transaction History Search", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "How do you ensure data privacy in financial applications?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design an Anti-Money Laundering Detection System", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Best Time to Buy and Sell Stock", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Digital Wallet System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you navigated ambiguity", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Concurrent Queue", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Why CIBC?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "BMO", domain: "bmo.com", category: "Canadian", totalQuestions: 13,
    questions: [
      { title: "Design a Capital Markets Trading Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Two Sum", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Tell me about a time you drove innovation", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Risk Assessment Engine", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Priority Queue for Trade Orders", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Multi-Channel Banking Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Longest Substring Without Repeating Characters", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "How do you approach legacy system modernization?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Batch Payment Processing System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Rate Limiter", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Design a Customer 360 Data Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Tell me about a time you balanced speed and quality", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Senior", type: "onsite", url: "" },
      { title: "Why BMO?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "Scotiabank", domain: "scotiabank.com", category: "Canadian", totalQuestions: 13,
    questions: [
      { title: "Design a Global Payment Settlement System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Valid Parentheses", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Tell me about a time you worked across cultures", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Foreign Exchange Rate Engine", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Currency Converter with Caching", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a KYC/AML Compliance Pipeline", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Merge Two Sorted Lists", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "How do you approach building for international markets?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Credit Card Rewards System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Graph-Based Fraud Network Detector", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Hard", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Real-Time Market Data Feed", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Tell me about a time you simplified a complex process", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Why Scotiabank?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "National Bank", domain: "nbc.ca", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Digital Banking Onboarding Flow", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Climbing Stairs (Dynamic Programming)", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Tell me about a time you championed a new technology", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Wealth Management Portfolio Dashboard", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Scheduled Payment Processor", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Secure Document Upload System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Number of Islands", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "How do you approach bilingual application development?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design an Investment Recommendation Engine", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Transaction Categorizer", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Why National Bank?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "Deloitte Canada", domain: "deloitte.ca", category: "Canadian", totalQuestions: 14,
    questions: [
      { title: "Design a Cloud Migration Strategy Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Data Pipeline Orchestrator", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you delivered value to a client", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Multi-Tenant Analytics Dashboard", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Graph Traversal for Org Hierarchy", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Regulatory Reporting System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "How do you manage competing client priorities?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Rule Engine for Tax Calculations", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Digital Transformation Roadmap Tool", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Word Break (Dynamic Programming)", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Tell me about a time you influenced without authority", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Senior", type: "onsite", url: "" },
      { title: "Design an Audit Trail System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Workflow State Machine", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Why consulting?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "Accenture Canada", domain: "accenture.com", category: "Canadian", totalQuestions: 12,
    questions: [
      { title: "Design a Microservices Architecture for Enterprise", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Service Discovery Mechanism", topic: "Coding", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you managed a difficult stakeholder", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a DevOps CI/CD Pipeline", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Load Balancer Algorithm", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Customer Data Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "How do you approach large-scale system integration?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Cache with Eviction Policies", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design an API Gateway", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Group Anagrams", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Tell me about a time you led a team through ambiguity", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Senior", type: "onsite", url: "" },
      { title: "Why Accenture?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "CGI", domain: "cgi.com", category: "Canadian", totalQuestions: 12,
    questions: [
      { title: "Design a Government Services Portal", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Secure File Upload System", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you worked on a large-scale government project", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Case Management System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Search with Pagination", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Batch Processing Framework", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "How do you handle security requirements in enterprise software?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Role-Based Access Control System", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Data Warehouse ETL Pipeline", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Validate Binary Search Tree", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Tell me about a time you delivered a project on time and budget", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Why CGI?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "KPMG Canada", domain: "kpmg.ca", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Financial Audit Automation Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Data Reconciliation Algorithm", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you identified a risk early", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Tax Filing Workflow System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Document Classification Engine", topic: "Coding", subtopic: "Machine Learning", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Compliance Monitoring Dashboard", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "How do you approach data-driven decision making?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Top K Frequent Elements", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Secure Client Data Portal", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about communicating complex findings to non-technical stakeholders", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Senior", type: "onsite", url: "" },
      { title: "Why KPMG?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "PwC Canada", domain: "pwc.com", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Risk Assessment Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Data Validation Pipeline", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you solved a complex client problem", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Digital Assurance Testing Framework", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Report Generation Engine", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Design a Blockchain-Based Audit Trail", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "How do you stay current with emerging technologies?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Implement a Tree-Based Organizational Chart", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Design a Client Engagement Management System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you built trust with a client", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Why PwC?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "EY Canada", domain: "ey.com", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Transaction Advisory Data Room", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Financial Data Parser", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you transformed a business process", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Sustainability Reporting Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Matching Algorithm for M&A Due Diligence", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Tax Optimization Engine", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "How do you approach building a better working world?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Implement a Document Similarity Scorer", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Design a Workforce Planning Tool", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Course Schedule (Topological Sort)", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Why EY?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "McKinsey", domain: "mckinsey.com", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Strategy Recommendation Engine", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a Market Sizing Calculator", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Case: A bank wants to increase digital adoption by 40%", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Hard", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Knowledge Management Platform", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Decision Tree Classifier", topic: "Coding", subtopic: "Machine Learning", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Client Impact Measurement System", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "How do you structure ambiguous problems?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Monte Carlo Simulation", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Hard", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Tell me about a time you drove transformational change", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Senior", type: "onsite", url: "" },
      { title: "Design a Supply Chain Optimization Model", topic: "System Design", subtopic: "Machine Learning", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Why McKinsey?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  },
  {
    name: "Capgemini Canada", domain: "capgemini.com", category: "Canadian", totalQuestions: 11,
    questions: [
      { title: "Design a Cloud-Native Enterprise Application", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "Implement a REST API with Pagination and Filtering", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "New Grad", type: "phone_screen", url: "" },
      { title: "Tell me about a time you delivered a digital transformation project", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design an Event-Driven Architecture", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Message Broker Consumer", topic: "Coding", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Multi-Cloud Deployment Strategy", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Hard", seniority: "Senior", type: "onsite", url: "" },
      { title: "How do you approach agile delivery in large organizations?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a Database Migration Tool", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Design a Test Automation Framework", topic: "System Design", subtopic: "Distributed Systems", difficulty: "Medium", seniority: "Mid-Level", type: "onsite", url: "" },
      { title: "Implement a String Compression Algorithm", topic: "Coding", subtopic: "Data Structures & Algorithms", difficulty: "Easy", seniority: "New Grad", type: "onsite", url: "" },
      { title: "Why Capgemini?", topic: "Behavioral", subtopic: "Culture & Leadership", difficulty: "Easy", seniority: "New Grad", type: "phone_screen", url: "" }
    ]
  }
];

d.companies.push(...more);
fs.writeFileSync('frontend/src/data/interview-questions.json', JSON.stringify(d, null, 2));
console.log('Added', more.length, 'companies. Total:', d.companies.length);
const total = d.companies.reduce((s, c) => s + c.totalQuestions, 0);
console.log('Total questions:', total);
const canadian = d.companies.filter(c => c.category === 'Canadian');
console.log('Canadian companies:', canadian.length);
