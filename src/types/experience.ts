export interface Experience {
  title: string;
  company: string;
  dates?: string;
  location?: string;
  workplaceType?: string | null;
  description?: string | null;
  descriptionBullets?: string[] | null;
}
