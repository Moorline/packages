export function loadPromptSections(input: {
  fromUrl: string;
  relativePaths: string[];
  dynamicSections?: string[];
}): Promise<string[]>;
