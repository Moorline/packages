import manifest from './manifest.json' with { type: 'json' };

function formatCatalogEntry(entry) {
  const metadata = Object.entries(entry.metadata)
    .filter(([key]) => key !== 'name' && key !== 'description')
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(', ') : value}`)
    .join(' | ');
  const tags = entry.tags.length > 0 ? ` | tags=${entry.tags.join(', ')}` : '';
  return `- ${entry.name}: ${entry.description}${tags}${metadata ? ` | ${metadata}` : ''} | path=${entry.path}`;
}

export default {
  id: manifest.id,
  manifest,
  tools(context) {
    return [
      {
        name: 'load_skill',
        description: 'Load a skill by name, including its SKILL.md body and resource directory details.',
        inputSchema: {
          type: 'object',
          properties: {
            skill_name: {
              type: 'string',
              description: 'Exact skill name from the visible skill catalog.'
            },
            name: {
              type: 'string',
              description: 'Alias for skill_name.'
            }
          },
          additionalProperties: false
        },
        requiredCapability: 'fs.read',
        execute: async (input) => {
          const skillName = typeof input.skill_name === 'string' ? input.skill_name : typeof input.name === 'string' ? input.name : null;
          if (!skillName) {
            return { content: 'load_skill error: skill_name must be provided.' };
          }
          const skill = await context.loadSkill(skillName);
          if (!skill) {
            return { content: `load_skill error: no skill named "${skillName}" was found.` };
          }
          return {
            content: [
              `Skill: ${skill.name}`,
              `Description: ${skill.description}`,
              `Skill file: ${skill.path}`,
              `Skill directory: ${skill.path.replace(/[\\/]SKILL\.md$/, '')}`,
              `Tags: ${skill.tags.join(', ') || '(none)'}`,
              `Metadata: ${JSON.stringify(skill.metadata)}`,
              `Shared resources: ${skill.resourcePaths.length > 0 ? skill.resourcePaths.join(', ') : '(none)'}`,
              'SKILL.md:',
              skill.content
            ].join('\n')
          };
        }
      }
    ];
  },
  async beforeAgentPrompt(_input, context) {
    const skills = context.listSkills();
    if (skills.length === 0) {
      return [];
    }
    return [
      'Available skills catalog:',
      ...skills.map((skill) => formatCatalogEntry(skill)),
      'Do not assume the full skill body. Use the available load_skill tool when a listed skill is relevant.',
      'Treat loaded skills and instruction sources as internal context. Do not narrate skill-loading steps or mention AGENTS.md unless the operator explicitly asks.'
    ];
  }
};
