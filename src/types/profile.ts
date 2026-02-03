export interface ProfileExperience {
  title: string | null;
  company: string | null;
  dates: string | null;
  location: string | null;
  workplaceType: string | null;
  description: string | null;
  descriptionBullets: string[] | null;
  skills: string[];
  skillsMoreCount: number | null;
  skillsText: string | null;
  start: string | null;
  end: string | null;
}

export interface ProfileEducation {
  school: string | null;
  degree: string | null;
  dates: string | null;
}

export interface ProfileStatus {
  state: "complete" | "partial";
  reasons: string[];
}

export interface ProfileData {
  fullName: string | null;
  headline: string | null;
  location: string | null;
  photoUrl?: string | null;
  linkedinUrl?: string | null;
  experiences: ProfileExperience[];
  education?: ProfileEducation[];
  skills?: string[];
  relationDegree?: string | null;
  infos?: string | null;
  name?: string | null;
  photo_url?: string | null;
  linkedin_url?: string | null;
  current_title?: string | null;
  current_company?: string | null;
  about?: string | null;
  status?: ProfileStatus | null;
  debug?: Record<string, unknown> | null;
}
