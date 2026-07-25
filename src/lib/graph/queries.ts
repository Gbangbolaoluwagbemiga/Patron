// Patron-specific subgraph queries
// All jobs Patron posted are identified by depositor === agent wallet address

export const GET_AGENT_JOBS = `
  query GetAgentJobs($agentAddress: Bytes!) {
    escrows(
      where: { depositor: $agentAddress }
      orderBy: createdAt
      orderDirection: desc
      first: 50
    ) {
      id
      escrowId
      depositor
      beneficiary
      token
      totalAmount
      paidAmount
      deadline
      status
      isOpenJob
      projectTitle
      projectDescription
      createdAt
      milestones(orderBy: milestoneIndex, orderDirection: asc) {
        milestoneIndex
        amount
        description
        status
        submittedAt
        approvedAt
      }
      applications {
        freelancer
        coverLetter
        proposedTimeline
        appliedAt
        status
      }
    }
  }
`;

export const GET_JOB_APPLICATIONS = `
  query GetJobApplications($escrowId: String!) {
    escrow(id: $escrowId) {
      escrowId
      status
      applications {
        freelancer
        coverLetter
        proposedTimeline
        appliedAt
        status
      }
    }
  }
`;

export const GET_JOB_BY_ID = `
  query GetJobById($escrowId: String!) {
    escrow(id: $escrowId) {
      id
      escrowId
      depositor
      beneficiary
      token
      totalAmount
      paidAmount
      deadline
      status
      projectTitle
      projectDescription
      createdAt
      milestones(orderBy: milestoneIndex, orderDirection: asc) {
        milestoneIndex
        amount
        description
        status
        submittedAt
        approvedAt
      }
      applications {
        freelancer
        coverLetter
        proposedTimeline
        appliedAt
        status
      }
    }
  }
`;

// Response types
export interface GQLApplication {
  freelancer: string;
  coverLetter: string;
  proposedTimeline: string;
  appliedAt: string;
  status: number;
}

export interface GQLMilestone {
  milestoneIndex: string;
  amount: string;
  description: string;
  status: number;
  submittedAt: string | null;
  approvedAt: string | null;
}

export interface GQLEscrow {
  id: string;
  escrowId: string;
  depositor: string;
  beneficiary: string;
  token: string;
  totalAmount: string;
  paidAmount: string;
  deadline: string;
  status: number;
  isOpenJob: boolean;
  projectTitle: string;
  projectDescription: string;
  createdAt: string;
  milestones: GQLMilestone[];
  applications: GQLApplication[];
}
