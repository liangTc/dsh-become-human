let boundary;
export function installSingleSessionBoundary(value){if(boundary&&boundary!==value)throw new Error('SINGLE_IM_OWNER_CONFLICT');boundary=value;}
export function singleSessionBoundary(){if(!boundary)throw new Error('SINGLE_IM_BOUNDARY_REQUIRED');return boundary;}
