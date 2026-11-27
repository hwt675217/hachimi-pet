import { launchPet } from '../../scripts/launch-pet.mjs';

const code = await launchPet({ foreground: true });
process.exit(code);
