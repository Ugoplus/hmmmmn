// services/openai.js - Enhanced version with human-friendly job labels

const { Queue, QueueEvents } = require('bullmq');
const crypto = require('crypto');
const { redis, queueRedis, sessionRedis } = require('../config/redis');
const logger = require('../utils/logger');
const RateLimiter = require('../utils/rateLimiter');

// Enhanced queue configuration for better performance
const openaiQueue = new Queue('openai-tasks', { 
  connection: queueRedis,
  prefix: 'queue:',
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      age: 300,      // Remove completed jobs after 5 minutes
      count: 100,    // Keep max 100 completed jobs
    },
    removeOnFail: {
      age: 1800,     // Remove failed jobs after 30 minutes
      count: 50,     // Keep max 50 failed jobs
    },
    ttl: 30000,      // Job timeout: 30 seconds
  },
});

// Create QueueEvents with separate connection
const queueEvents = new QueueEvents('openai-tasks', { 
  connection: queueRedis,
  prefix: 'queue:'
});
queueEvents.on('ready', () => {
  logger.info('QueueEvents ready for openai-tasks');
});

queueEvents.on('error', (error) => {
  logger.error('QueueEvents error', { error: error.message });
});

class AIService {
  constructor() {
    this.queryCache = new Map();
    this.cacheMaxSize = 2000;
    this.cacheMaxAge = 10 * 60 * 1000;
    
    // Performance metrics (for monitoring)
    this.metrics = {
      cacheHits: 0,
      patternMatches: 0,
      aiCalls: 0,
      totalRequests: 0
    };
    
    // Human-friendly job category labels
    this.jobLabels = {
      'accounting_finance': 'Accounting & Finance',
      'admin_office': 'Administration & Office Support',
      'engineering_technical': 'Developer & Engineering',
      'it_software': 'IT & Software',
      'marketing_sales': 'Sales & Marketing',
      'healthcare_medical': 'Healthcare & Medical',
      'education_training': 'Education & Training',
      'management_executive': 'Management & Executive',
      'human_resources': 'Human Resources',
      'logistics_supply': 'Logistics & Supply Chain',
      'customer_service': 'Customer Service',
      'legal_compliance': 'Legal & Compliance',
      'media_creative': 'Media & Creative',
      'security_safety': 'Security & Safety',
      'construction_real_estate': 'Construction & Real Estate',
      'manufacturing_production': 'Manufacturing & Production',
      'retail_fashion': 'Retail & Fashion',
      'transport_driving': 'Transport & Driving',
      'other_general': 'General Jobs'
    };

    // Friendly search phrases (randomized)
    this.searchPhrases = [
      'Looking for {jobType} opportunities in {location}...',
      'Searching {jobType} roles in {location}...',
      'Finding the latest {jobType} jobs in {location}...',
      'Checking {jobType} positions in {location}...',
      'Discovering {jobType} openings in {location}...',
    ];

    // Keywords for better job detection
    this.jobKeywords = {
'lawyer': 'legal_compliance',
'attorney': 'legal_compliance',
'barrister': 'legal_compliance',
'solicitor': 'legal_compliance',
'paralegal': 'legal_compliance',
'legal officer': 'legal_compliance',
'legal manager': 'legal_compliance',
'legal secretary': 'legal_compliance',
'legal advisor': 'legal_compliance',
'legal counsel': 'legal_compliance',
'compliance officer': 'legal_compliance',
'compliance': 'legal_compliance',
'legal': 'legal_compliance',

// ADMIN & OFFICE - ENHANCED (Secretary/Receptionist missing)
'secretary': 'admin_office',
'legal secretary': 'admin_office',
'receptionist': 'admin_office',
'front desk': 'admin_office',
'front desk executive': 'admin_office',
'front office executive': 'admin_office',
'admin officer': 'admin_office',
'administrative officer': 'admin_office',
'administrative assistant': 'admin_office',
'admin assistant': 'admin_office',
'office assistant': 'admin_office',
'executive assistant': 'admin_office',
'personal assistant': 'admin_office',
'clerical assistant': 'admin_office',
'clerical': 'admin_office',
'data entry': 'admin_office',
'data entry assistant': 'admin_office',
'office manager': 'admin_office',

// MEDIA & CREATIVE - ENHANCED
'graphic designer': 'media_creative',
'graphics designer': 'media_creative',
'web designer': 'media_creative',
'designer': 'media_creative',
'content creator': 'media_creative',
'content writer': 'media_creative',
'content manager': 'media_creative',
'content': 'media_creative',
'social media manager': 'media_creative',
'social media handler': 'media_creative',
'social media': 'media_creative',
'video editor': 'media_creative',
'video producer': 'media_creative',
'videographer': 'media_creative',
'photographer': 'media_creative',
'photography': 'media_creative',
'journalist': 'media_creative',
'creative director': 'media_creative',
'creative': 'media_creative',
'brand manager': 'media_creative',
'digital marketing': 'media_creative',

// CONSTRUCTION & REAL ESTATE - ENHANCED (Foreman missing)
'foreman': 'construction_real_estate',
'site foreman': 'construction_real_estate',
'construction foreman': 'construction_real_estate',
'construction supervisor': 'construction_real_estate',
'site supervisor': 'construction_real_estate',
'construction manager': 'construction_real_estate',
'site manager': 'construction_real_estate',
'project manager construction': 'construction_real_estate',
'civil engineer': 'construction_real_estate',
'structural engineer': 'construction_real_estate',
'quantity surveyor': 'construction_real_estate',
'architect': 'construction_real_estate',
'construction': 'construction_real_estate',
'real estate': 'construction_real_estate',
'property manager': 'construction_real_estate',
'realtor': 'construction_real_estate',
'estate agent': 'construction_real_estate',

// HEALTHCARE & MEDICAL - ENHANCED
'medical officer': 'healthcare_medical',
'medical doctor': 'healthcare_medical',
'medical laboratory scientist': 'healthcare_medical',
'medical laboratory technician': 'healthcare_medical',
'laboratory scientist': 'healthcare_medical',
'laboratory technician': 'healthcare_medical',
'medical physicist': 'healthcare_medical',
'radiation therapist': 'healthcare_medical',
'radiation oncologist': 'healthcare_medical',
'oncology officer': 'healthcare_medical',
'radiographer': 'healthcare_medical',
'microbiologist': 'healthcare_medical',
'chemist': 'healthcare_medical',
'food technologist': 'healthcare_medical',
'production pharmacist': 'healthcare_medical',
'clinical administrator': 'healthcare_medical',
'nursing manager': 'healthcare_medical',
'industrial nurse': 'healthcare_medical',
'epi nurse': 'healthcare_medical',
'registered nurse': 'healthcare_medical',
'nurse midwife': 'healthcare_medical',
'caregiver': 'healthcare_medical',
'health promoter': 'healthcare_medical',
'health officer': 'healthcare_medical',
'medical receptionist': 'healthcare_medical',
'medical data processor': 'healthcare_medical',

// LOGISTICS & SUPPLY CHAIN - ENHANCED
'store officer': 'logistics_supply',
'store manager': 'logistics_supply',
'store assistant': 'logistics_supply',
'storekeeper': 'logistics_supply',
'warehouse manager': 'logistics_supply',
'warehouse assistant': 'logistics_supply',
'warehouse clerk': 'logistics_supply',
'warehouse incharge': 'logistics_supply',
'purchasing officer': 'logistics_supply',
'purchasing manager': 'logistics_supply',
'purchase manager': 'logistics_supply',
'procurement officer': 'logistics_supply',
'procurement manager': 'logistics_supply',
'logistics officer': 'logistics_supply',
'logistics supervisor': 'logistics_supply',
'transport officer': 'logistics_supply',
'transport supervisor': 'logistics_supply',
'supply chain': 'logistics_supply',
'inventory': 'logistics_supply',

// MANUFACTURING & PRODUCTION - ENHANCED  
'production manager': 'manufacturing_production',
'production superintendent': 'manufacturing_production',
'quality control': 'manufacturing_production',
'quality assurance': 'manufacturing_production',
'quality assurance manager': 'manufacturing_production',
'lab analyst': 'manufacturing_production',
'technical operator': 'manufacturing_production',
'factory accountant': 'manufacturing_production',
'feed miller': 'manufacturing_production',
'forklift operator': 'manufacturing_production',
'mechanical technician': 'manufacturing_production',
'maintenance technician': 'manufacturing_production',
'maintenance officer': 'manufacturing_production',
'maintenance manager': 'manufacturing_production',
'maintenance planner': 'manufacturing_production',

// EDUCATION & TRAINING - ENHANCED
'montessori teacher': 'education_training',
'french teacher': 'education_training',
'music teacher': 'education_training',
'biology teacher': 'education_training',
'english teacher': 'education_training',
'technical training instructor': 'education_training',
'yoga instructor': 'education_training',
'coach': 'education_training',

// TRANSPORT & DRIVING - ENHANCED
'mini truck driver': 'transport_driving',
'pool car driver': 'transport_driving',
'baggage handler': 'transport_driving',
'crew scheduling officer': 'transport_driving',

// SECURITY & SAFETY - ENHANCED
'hse officer': 'security_safety',
'health safety environment': 'security_safety',
'environment health safety': 'security_safety',
'safety security health': 'security_safety',
'hse coordinator': 'security_safety',
'hse graduate trainee': 'security_safety',
'safety coordinator': 'security_safety',
'security coordinator': 'security_safety',
'ehs officer': 'security_safety',
'mine safety officer': 'security_safety',

// CUSTOMER SERVICE - ENHANCED
'customer service executive': 'customer_service',
'customer sales executive': 'customer_service',
'customer care officer': 'customer_service',
'call center agent': 'customer_service',
'customer service representative': 'customer_service',

// HUMAN RESOURCES - ENHANCED
'human resource manager': 'human_resources',
'human resource officer': 'human_resources',
'hr manager': 'human_resources',
'hr officer': 'human_resources',
'hr admin manager': 'human_resources',
'hr associates': 'human_resources',
'hr business partner': 'human_resources',
'hrbp': 'human_resources',
'human resources intern': 'human_resources',
'diversity recruiter': 'human_resources',
'payroll specialist': 'human_resources',

// BANKING & FINANCE - ENHANCED
'teller': 'accounting_finance',
'banker': 'accounting_finance',
'relationship manager': 'accounting_finance',
'key account manager': 'accounting_finance',
'account officer': 'accounting_finance',
'accounts clerk': 'accounting_finance',
'accounts payable': 'accounting_finance',
'accounts receivable': 'accounting_finance',
'chartered accountant': 'accounting_finance',
'management accountant': 'accounting_finance',
'trainee accountant': 'accounting_finance',
'factory accountant': 'accounting_finance',
'finance accounts manager': 'accounting_finance',
'financial controller': 'accounting_finance',
'budget analyst': 'accounting_finance',
'tax assistant': 'accounting_finance',
'internal control officer': 'accounting_finance',

// SPECIALIZED ROLES
'agronomist': 'other_general',
'field enumerator': 'other_general', 
'data enumerator': 'other_general',
'research assistant': 'other_general',
'documentary researcher': 'other_general',
'nanny': 'other_general',
'sous chef': 'other_general',
'pastor': 'other_general',
'volunteer': 'other_general',
};
    
    // Your existing jobTypes object (keep for database searches)
    this.jobTypes = {
      'accounting_finance': ['account', 'accountant', 'accounting', 'accounts', 'acquisition', 'actuarial', 'admin', 'administrator', 'agents', 'airlines', 'akwa', 'annona', 'ascentech', 'assistant', 'associate', 'audit', 'auditing', 'bank', 'banking', 'based', 'bauchi', 'best', 'blending', 'bookkeep', 'bookkeeper', 'budget', 'bureau', 'cashier', 'chartered', 'clay', 'clerk', 'commercial', 'commission', 'company', 'compliance', 'consultancy', 'control', 'corporation', 'crc', 'credit', 'crescita', 'database', 'development', 'distribution', 'dufil', 'eastern', 'eedc', 'electricity', 'energy', 'enugu', 'executive', 'factory', 'feed', 'felton', 'fertilizer', 'fesl', 'finance', 'financial', 'flour', 'foods', 'frontieres', 'funds', 'grains', 'head', 'hello', 'ibom', 'imtt', 'initiative', 'institutional', 'insurance', 'internal', 'inventory', 'investment', 'ire', 'key', 'labdi', 'life', 'limited', 'loan', 'manager', 'medecins', 'mills', 'mobilization', 'msf', 'nesco', 'nigeria', 'nigerian', 'officer', 'payable', 'payroll', 'plant', 'plc', 'premier', 'prima', 'products', 'project', 'promasidor', 'receivable', 'relationship', 'remote', 'retail', 'rfs', 'rosabon', 'sans', 'senior', 'services', 'sme', 'solutions', 'sterling', 'supply', 'taimaka', 'tax', 'traveldeer', 'treasury', 'united', 'vitafoam'],
      'admin_office': ['abia', 'achieving', 'action', 'adamawa', 'admin', 'administration', 'administrative', 'administrator', 'advocacy', 'africa', 'agribusiness', 'agriculture', 'ahni', 'aide', 'airlines', 'analyst', 'ascentech', 'assistant', 'assistants', 'associate', 'background', 'bank', 'base', 'best', 'beverages', 'biotechnology', 'branch', 'bristow', 'business', 'care', 'casfod', 'cash', 'catalyst', 'chicmicro', 'children', 'church', 'city', 'clerk', 'climate', 'clinical', 'collector', 'committed', 'community', 'company', 'consortium', 'construction', 'consultancy', 'consultant', 'consulting', 'control', 'cooperazione', 'coopi', 'coordinator', 'copyright', 'corrugation', 'council', 'craneburg', 'crescita', 'crew', 'ctg', 'cuddle', 'dangote', 'data', 'data entry', 'des', 'development', 'displaced', 'documentation', 'dreamworks', 'eastern', 'ebonyi', 'ecews', 'ecw', 'education', 'ehs', 'emerald', 'emergency', 'employee', 'empowerment', 'energy', 'engagement', 'entry', 'environment', 'evaluation', 'excellence', 'face', 'facility', 'family', 'feed', 'fellowship', 'fer', 'fever', 'fidelity', 'field', 'filing', 'finance', 'finpact', 'fleet', 'flour', 'food', 'forward', 'foundation', 'frontieres', 'fund', 'fze', 'ganfeng', 'general', 'getpayed', 'global', 'gongola', 'good', 'goonite', 'group', 'growth', 'hands', 'health', 'healthcare', 'helicopters', 'help', 'helpers', 'hiv', 'hommes', 'human', 'hygiene', 'icla', 'iec', 'incorporated', 'industries', 'industry', 'informatics', 'information', 'initiative', 'internal', 'international', 'internationale', 'internazionale', 'iom', 'jhpiego', 'kedi', 'labdi', 'lassa', 'leprosy', 'lhi', 'liaison', 'licensing', 'life', 'limited', 'lithium', 'livelihood', 'living', 'logistics', 'maintenance', 'malaria', 'malnutrition', 'management', 'manager', 'managers', 'marketing', 'materials', 'matter', 'mcsn', 'meal', 'mechanized', 'medecins', 'migration', 'mills', 'mine', 'minim', 'mission', 'mitigation', 'moniepoint', 'monitoring', 'montego', 'msf', 'music', 'musical', 'national', 'nations', 'nepwhan', 'network', 'new', 'nfdp', 'niger', 'nigeria', 'northwest', 'norwegian', 'nrc', 'nuru', 'nutrition', 'office', 'officer', 'officers', 'offices', 'oncology', 'ondo', 'operations', 'operator', 'oppo', 'optimus', 'organization', 'organizational', 'outreach', 'packaging', 'pam', 'path', 'pathfinder', 'pension', 'people', 'persons', 'plastic', 'plc', 'polaris', 'population', 'poverty', 'premier', 'premiere', 'procurement', 'product', 'program', 'programme', 'project', 'promoter', 'protection', 'public', 'pui', 'purchasing', 'quantum', 'receptionist', 'refugee', 'regional', 'reliable', 'research', 'resident', 'resource', 'safety', 'sales', 'sans', 'save', 'scheduling', 'scheme', 'secretary', 'section', 'security', 'self', 'senior', 'services', 'sfhf', 'sgbv', 'shulifang', 'sims', 'society', 'solutions', 'state', 'steel', 'store', 'support', 'sustainable', 'swoden', 'tdh', 'tearfund', 'technical', 'technology', 'terre', 'tlmn', 'tonye', 'too', 'transport', 'tyeeli', 'unfpa', 'unicef', 'union', 'unique', 'united', 'unity', 'upstream', 'urgence', 'vine', 'warehouse', 'wash', 'welfare', 'wfp', 'wima', 'women', 'world'],
      'engineering_technical': ['abia', 'abnl', 'africa', 'airways', 'apm', 'apple', 'architect', 'assurance', 'automation', 'biomedical', 'blaster', 'board', 'breweries', 'briscoe', 'cdcfib', 'chemical', 'civil', 'cloud', 'cng', 'coating', 'commission', 'commissioning', 'control', 'correctional', 'cost', 'crescita', 'dangote', 'data', 'defence', 'delta', 'devops', 'electrical', 'electrician', 'elper', 'energy', 'engineer', 'engineering', 'engineers', 'facilities', 'fire', 'food', 'foreman', 'green', 'group', 'hexagon', 'immigration', 'inspector', 'installation', 'instrument', 'international', 'lafarge', 'lagos', 'lead', 'limited', 'line', 'machinery', 'machines', 'maintenance', 'marine', 'mechanical', 'mhc', 'mhe', 'nigeria', 'oilfield', 'operator', 'packaging', 'pears', 'petroleum', 'planner', 'plant', 'plc', 'power', 'pre', 'process', 'quality', 'recruitment', 'repair', 'sales', 'scheduler', 'seplat', 'service', 'services', 'software', 'solutions', 'state', 'supervisor', 'technical', 'technician', 'terminals', 'tester', 'trainee', 'treatment', 'vacancies', 'wartsila', 'water'],
      'it_software': ['activity', 'alfred', 'app', 'apple', 'apprenticeship', 'area', 'associates', 'bank', 'cloud', 'coding', 'crescita', 'cyber', 'database', 'developer', 'embedded', 'energy', 'engineer', 'esosa', 'food', 'full', 'gen', 'innovations', 'international', 'kite', 'limited', 'livelihood', 'manager', 'marketer', 'mobile', 'network', 'nigeria', 'pears', 'plc', 'program', 'programmer', 'programming', 'representatives', 'sales', 'sap', 'security', 'senior', 'software', 'solidarites', 'solutions', 'stack', 'sterling', 'storekeeper', 'system', 'systems', 'victoria', 'vivo', 'web'],
      'marketing_sales': ['abo', 'advertising', 'affiliate', 'africa', 'agent', 'annona', 'area', 'ascentech', 'associate', 'bank', 'benckiser', 'bess', 'bottling', 'brand', 'branding', 'breweries', 'business', 'campaign', 'champions', 'client', 'cocoa', 'commerce', 'company', 'consulting', 'corporate', 'crescita', 'customer', 'dairy', 'delegation', 'development', 'dicalo', 'diesel', 'digital', 'direct', 'divisional', 'ekini', 'end', 'entrepreneurship', 'executive', 'food', 'foods', 'foundation', 'funnel', 'gas', 'gensets', 'genuine', 'german', 'goldfish', 'grains', 'grants', 'group', 'growth', 'hacker', 'head', 'high', 'hrbp', 'human', 'industries', 'industry', 'integrated', 'international', 'interswitch', 'kickstart', 'limited', 'manager', 'managers', 'manufacturing', 'marketing', 'medical', 'medium', 'mentorship', 'milk', 'million', 'mills', 'mol', 'naira', 'nigeria', 'nigerians', 'north', 'palmpay', 'partner', 'payments', 'plc', 'power', 'processing', 'procurement', 'programme', 'promotion', 'providus', 'reckitt', 'red', 'regional', 'relationship', 'representatives', 'resourse', 'rsin', 'sales', 'salesforce', 'septagus', 'services', 'seven', 'snacks', 'social media', 'solutions', 'sonia', 'star', 'sterling', 'supervisor', 'supervisors', 'territory', 'tide', 'training', 'tse', 'tsm', 'tulip', 'uac', 'vitafoam', 'wellcome', 'west', 'white', 'young', 'zest', 'zhongyuan'],
      'healthcare_medical': ['action', 'alima', 'alliance', 'archivist', 'associates', 'avatar', 'biomedical', 'center', 'chemist', 'children', 'clinical', 'community', 'company', 'corporation', 'data', 'deputy', 'diagnostic', 'doctor', 'donkor', 'electricity', 'energy', 'entry', 'environment', 'fever', 'first', 'frontieres', 'head', 'health', 'hospital', 'hospitality', 'international', 'internationale', 'jda', 'jerry', 'jhpiego', 'jigawa', 'laboratory', 'lamb', 'lassa', 'lead', 'level', 'limited', 'manager', 'materials', 'medecins', 'medical', 'microbiologist', 'ministry', 'msf', 'nesco', 'new', 'nigeria', 'nigerian', 'nurse', 'observators', 'officer', 'pharmaceutical', 'pharmacist', 'pharmacy', 'physician', 'plc', 'premiere', 'processor', 'production', 'program', 'project', 'pui', 'qhse', 'quality', 'records', 'research', 'resident', 'rivers', 'ruth', 'safety', 'sans', 'scientist', 'she', 'site', 'state', 'supervisors', 'supply', 'technician', 'therapy', 'unilever', 'urgence', 'worker'],
      'education_training': ['academic', 'admiralty', 'ado', 'adorable', 'advertisement', 'alex', 'alike', 'benin', 'biology', 'blue', 'book', 'borderlesshr', 'british', 'calabar', 'clark', 'college', 'commission', 'construction', 'curriculum', 'development', 'diageo', 'dutse', 'ecu', 'education', 'edwin', 'ekiti', 'ekwueme', 'english', 'european', 'external', 'federal', 'frontieres', 'fud', 'funai', 'graduates', 'institute', 'instructor', 'invitation', 'isouchi', 'kings', 'learning', 'life', 'management', 'manager', 'massive', 'medecins', 'month', 'msf', 'national', 'ndogo', 'ndufu', 'nictm', 'nigeria', 'nigerians', 'non', 'paid', 'polytechnic', 'positions', 'program', 'recruitment', 'sans', 'school', 'search', 'staff', 'teacher', 'technology', 'traineeship', 'training', 'tutor', 'university', 'uromi', 'vacancies', 'worldwide', 'young'],
      'management_executive': ['action', 'advisory', 'africaplan', 'against', 'airlines', 'aluminium', 'amo', 'anheuser', 'annona', 'apartment', 'assistant', 'assurance', 'bank', 'bernie', 'best', 'beverages', 'bogo', 'bottling', 'branch', 'breweries', 'busch', 'byng', 'ceo', 'cfo', 'chain', 'chief', 'child', 'commerce', 'commercial', 'communication', 'company', 'conservation', 'construction', 'consulting', 'coo', 'cooperazione', 'coopi', 'country', 'cradi', 'crescita', 'crest', 'data', 'delegation', 'deputy', 'development', 'dicalo', 'diligence', 'director', 'displaced', 'district', 'east', 'empowerment', 'engine', 'ernst', 'evaluation', 'executive', 'executives', 'experiential', 'field', 'fleet', 'foundation', 'gas', 'german', 'global', 'goalprime', 'gpon', 'grains', 'group', 'head', 'health', 'holdings', 'housekeeper', 'human', 'hunger', 'hygiene', 'inbev', 'incorporated', 'industries', 'industry', 'initiative', 'institute', 'international', 'internationale', 'internazionale', 'labdi', 'lead', 'leading', 'life', 'limited', 'lington', 'management', 'manager', 'markets', 'meal', 'mills', 'minim', 'moniepoint', 'monitoring', 'new', 'nfdp', 'nigeria', 'nosagie', 'nursing', 'nutrition', 'officer', 'oil', 'operation', 'operations', 'optimization', 'optimus', 'organization', 'packaging', 'persons', 'philanthropies', 'plc', 'portfolio', 'premiere', 'principal', 'procurement', 'production', 'program', 'programme', 'programs', 'project', 'projects', 'property', 'protection', 'pui', 'purchase', 'quality', 'redeemer', 'research', 'resource', 'retail', 'rhv', 'sanitation', 'search', 'senior', 'seo', 'service', 'seven', 'sigma', 'site', 'society', 'solidarites', 'solutions', 'station', 'stellar', 'storekeeper', 'sundry', 'supervisor', 'supply', 'swoden', 'tantacom', 'technology', 'tellers', 'thriving', 'tonye', 'trainee', 'transaction', 'united', 'urgence', 'vagan', 'village', 'voice', 'wash', 'water', 'wcs', 'wildlife', 'woman', 'women', 'young', 'zumera'],
      'human_resources': ['air', 'assistant', 'associates', 'bank', 'benefits', 'company', 'conservation', 'dssc', 'economy', 'employee', 'energy', 'fellowship', 'force', 'fully', 'funded', 'government', 'hr', 'human', 'human resources', 'indigenous', 'industrial', 'industry', 'intern', 'internationale', 'internships', 'japan', 'limited', 'logistics', 'manager', 'meti', 'ministry', 'nations', 'new', 'nigerian', 'ohchr', 'ongoing', 'payroll', 'personnel', 'premiere', 'programme', 'pui', 'recruiter', 'recruitment', 'relations', 'resources', 'shomas', 'society', 'staffing', 'supply', 'talent', 'tech', 'titan', 'trade', 'training', 'trust', 'tyeeli', 'united', 'urgence', 'wcs', 'wildlife', 'worknigeria'],
      'logistics_supply': ['analyst', 'assistant', 'breweries', 'control', 'controller', 'cussons', 'delivery', 'displaced', 'distribution', 'fleet', 'foundation', 'international', 'inventory', 'limited', 'logistics', 'new', 'nfdp', 'nigeria', 'officer', 'operations', 'persons', 'planner', 'plc', 'procurement', 'purchasing', 'shipping', 'shomas', 'supervisor', 'supply', 'transportation', 'warehouse'],
      'customer_service': ['airlines', 'ascentech', 'bank', 'call center', 'care', 'client service', 'cse', 'customer', 'customer service', 'customer support', 'executive', 'help desk', 'limited', 'logistics', 'myafrimall', 'nigeria', 'officer', 'optimus', 'representatives', 'service', 'services', 'storekeeper', 'support', 'united'],
      'legal_compliance': ['advisor', 'attorney', 'compliance', 'contract', 'contracts', 'corporate law', 'crescita', 'lawyer', 'legal', 'legal counsel', 'litigation', 'regulatory', 'solutions'],
      'media_creative': ['breweries', 'cereals', 'company', 'content', 'creative', 'design', 'designer', 'editor', 'energy', 'exploration', 'foremen', 'gcl', 'grand', 'graphic', 'iconic', 'industries', 'international', 'journalist', 'limited', 'material', 'media', 'oil', 'open', 'photography', 'planner', 'plastic', 'plc', 'product', 'production', 'reliable', 'rigger', 'sap', 'scheduler', 'seepco', 'steel', 'sterling', 'superintendent', 'university', 'video', 'writer'],
      'security_safety': ['breweries', 'controller', 'environment', 'guard', 'international', 'plc', 'protection', 'risk', 'safety', 'security', 'surveillance'],
      'construction_real_estate': ['architect', 'building', 'construction', 'contractor', 'crescita', 'expert', 'link', 'project management', 'property', 'real estate', 'seo', 'solutions', 'surveyor'],
      'manufacturing_production': ['assembly', 'assistant', 'campboss', 'control', 'cussons', 'econation', 'factory', 'feed', 'flour', 'forklift', 'gol', 'grand', 'human', 'industrial', 'industries', 'limited', 'manufacturing', 'mills', 'nigeria', 'oak', 'offshore', 'operator', 'plastic', 'plc', 'premier', 'processing', 'production', 'program', 'quality', 'quality control', 'reliable', 'resource', 'steel', 'supervisor', 'technician', 'trainee', 'turbine', 'whassan'],
      'retail_fashion': ['buyer', 'construczione', 'fashion', 'limited', 'merchandise', 'migliore', 'retail', 'shop', 'store', 'storekeeper', 'tecniche', 'visual'],
      'transport_driving': ['beverages', 'car', 'commissioner', 'company', 'courier', 'delivery', 'dispatch', 'driver', 'emerald', 'food', 'fund', 'high', 'limited', 'logistics', 'mini', 'nations', 'pool', 'population', 'refugees', 'transport', 'truck', 'unfpa', 'unhcr', 'united'],
      'other_general': ['abia', 'afdb', 'africa', 'african', 'agricultural', 'airlines', 'associate', 'baggage', 'bank', 'berger', 'books', 'bottling', 'cbm', 'chevening', 'commission', 'communications', 'company', 'consortium', 'consulting', 'cradi', 'crest', 'data', 'degree', 'delta', 'development', 'diverse', 'documentary', 'emmix', 'energy', 'entry', 'entry level', 'enumerator', 'enumerators', 'evaluation', 'felton', 'fesl', 'field', 'fitters', 'flexfilms', 'fmcg', 'foundation', 'frontieres', 'fully', 'funded', 'general', 'global', 'government', 'governmental', 'gpd', 'graduate', 'graduates', 'group', 'handler', 'havana', 'helen', 'hki', 'hse', 'implementation', 'indigenous', 'institute', 'intern', 'international', 'internationale', 'internship', 'julius', 'keller', 'kimberly', 'lafarge', 'legal', 'level', 'lga', 'limited', 'literacy', 'local', 'malaria', 'master', 'medecins', 'merit', 'microbiologist', 'midwife', 'monitoring', 'msf', 'multiple', 'national', 'nddc', 'niger', 'nigeria', 'nnpc', 'non', 'officer', 'organization', 'peace', 'phlebotomists', 'piecurve', 'placement', 'plc', 'post', 'premiere', 'profit', 'program', 'programme', 'projects', 'psychologist', 'pui', 'qualitative', 'recent', 'research', 'researcher', 'ryan', 'sans', 'scheme', 'scholarship', 'septagus', 'services', 'session', 'seven', 'smartflow', 'social', 'state', 'structural', 'students', 'study', 'sun', 'survey', 'synlab', 'technologies', 'tellers', 'totalenergies', 'trainee', 'tsdp', 'unesco', 'united', 'urgence', 'vacancies', 'various', 'welders', 'worker', 'world'],
    };

    this.locations = {
      // Original major cities
      'lagos': 'Lagos',
      'abuja': 'Abuja',
      'port harcourt': 'Port Harcourt',
      'portharcourt': 'Port Harcourt',
      'remote': 'Remote',
      
      // All 36 Nigerian States
      'abia': 'Abia',
      'adamawa': 'Adamawa', 
      'akwa ibom': 'Akwa Ibom',
      'anambra': 'Anambra',
      'bauchi': 'Bauchi',
      'bayelsa': 'Bayelsa',
      'benue': 'Benue',
      'borno': 'Borno',
      'cross river': 'Cross River',
      'delta': 'Delta',
      'ebonyi': 'Ebonyi',
      'edo': 'Edo',
      'ekiti': 'Ekiti',
      'enugu': 'Enugu',
      'gombe': 'Gombe',
      'imo': 'Imo',
      'jigawa': 'Jigawa',
      'kaduna': 'Kaduna',
      'kano': 'Kano',
      'katsina': 'Katsina',
      'kebbi': 'Kebbi',
      'kogi': 'Kogi',
      'kwara': 'Kwara',
      'niger': 'Niger',
      'ogun': 'Ogun',
      'ondo': 'Ondo',
      'osun': 'Osun',
      'oyo': 'Oyo',
      'plateau': 'Plateau',
      'rivers': 'Rivers',
      'sokoto': 'Sokoto',
      'taraba': 'Taraba',
      'yobe': 'Yobe',
      'zamfara': 'Zamfara',
      
      // FCT
      'fct': 'FCT',
      
      // Major cities for convenience
      'ibadan': 'Oyo',          // Ibadan is in Oyo state
      'jos': 'Plateau',         // Jos is in Plateau state
      'kano city': 'Kano',      // Kano city in Kano state
      'benin': 'Edo',           // Benin City is in Edo state
      'calabar': 'Cross River', // Calabar is in Cross River
      'uyo': 'Akwa Ibom',       // Uyo is in Akwa Ibom
      'warri': 'Delta',         // Warri is in Delta state
      'maiduguri': 'Borno',     // Maiduguri is in Borno
      'ilorin': 'Kwara',        // Ilorin is in Kwara
      'abeokuta': 'Ogun'        // Abeokuta is in Ogun
    };
    
    setInterval(() => this.cleanCache(), 60000);
    setInterval(() => this.logMetrics(), 300000); // Log metrics every 5 minutes
  }

  // Enhanced job detection method
  detectJobTypeFromMessage(text) {
    const lowerText = text.toLowerCase();
    
    // First try specific keywords mapping
    for (const [keyword, category] of Object.entries(this.jobKeywords)) {
      if (lowerText.includes(keyword)) {
        return {
          category: category,
          rawTitle: this.extractJobTitle(text, keyword),
          detectedKeyword: keyword
        };
      }
    }
    
    // Fallback to original method
    for (const [type, keywords] of Object.entries(this.jobTypes)) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        return {
          category: type,
          rawTitle: this.extractJobTitle(text),
          detectedKeyword: null
        };
      }
    }
    
    return null;
  }

  // Extract the job title from user's message
  extractJobTitle(text, detectedKeyword = null) {
    const lowerText = text.toLowerCase();
    
    // Common job-related words to filter out
    const filterWords = ['jobs', 'job', 'work', 'find', 'looking', 'search', 'for', 'in', 'at', 'the', 'a', 'an'];
    
    // If we detected a specific keyword, use it
    if (detectedKeyword) {
      return detectedKeyword;
    }
    
    // Extract meaningful words from the message
    const words = text.toLowerCase().split(/\s+/)
      .filter(word => word.length > 2)
      .filter(word => !filterWords.includes(word))
      .filter(word => !this.isLocationWord(word));
    
    // Take the first 2-3 meaningful words as the job title
    return words.slice(0, 2).join(' ') || 'jobs';
  }

  isLocationWord(word) {
    return Object.keys(this.locations).some(location => location.includes(word));
  }

  // Get a random friendly search phrase
  getRandomSearchPhrase(jobType, location) {
    const phrases = this.searchPhrases;
    const randomPhrase = phrases[Math.floor(Math.random() * phrases.length)];
    return randomPhrase
      .replace('{jobType}', jobType)
      .replace('{location}', location);
  }

  async parseJobQuery(message, identifier = null, userContext = null) {
    this.metrics.totalRequests++;
    
    try {
      // LEVEL 1: Cache check (your existing logic)
      const cacheKey = this.getCacheKey(message);
      const cached = this.getFromCache(cacheKey);
      if (cached) {
        this.metrics.cacheHits++;
        logger.info('Cache hit', { identifier });
        return cached;
      }

      // LEVEL 2: Simple commands (your existing logic)
      const simpleResult = this.parseSimpleCommand(message);
      if (simpleResult) {
        logger.info('Used local parsing', { identifier, action: simpleResult.action });
        this.setCache(cacheKey, simpleResult);
        return simpleResult;
      }

      // LEVEL 3: Enhanced Smart patterns
      const patternResult = this.parseSmartPatternsEnhanced(message, userContext);
      if (patternResult) {
        this.metrics.patternMatches++;
        logger.info('Smart pattern match', { identifier, action: patternResult.action });
        this.setCache(cacheKey, patternResult);
        return patternResult;
      }

      // LEVEL 4: Rate limiting (your existing logic)
     if (identifier) {
      const aiLimit = await RateLimiter.checkLimit(identifier, 'ai_call');
      if (!aiLimit.allowed) {
        return {
          action: 'rate_limited',
          response: aiLimit.message
        };
      }
    }
      // LEVEL 5: AI processing (your existing logic)
      this.metrics.aiCalls++;
      logger.info('Using AI for complex query', { identifier });
      const aiResult = await this.parseWithAI(message, identifier, userContext);
      this.setCache(cacheKey, aiResult);
      return aiResult;

    } catch (error) {
      logger.error('parseJobQuery error', { error: error.message, identifier });
      return {
        action: 'error',
        response: 'I can help you find jobs! Try "find jobs in Lagos" or "help" for commands.'
      };
    }
  }

  // ENHANCED: parseSmartPatterns with better detection and user-friendly responses
  parseSmartPatternsEnhanced(message, userContext = null) {
    const text = message.toLowerCase().trim();
    
    // Extract session data
    const sessionData = userContext?.sessionData || {};
    
    // Enhanced job type detection
    const jobDetection = this.detectJobTypeFromMessage(text);
    let detectedJob = null;
    let rawTitle = null;
    let friendlyJobLabel = null;
    
    if (jobDetection) {
      detectedJob = jobDetection.category;
      rawTitle = jobDetection.rawTitle;
      friendlyJobLabel = this.jobLabels[detectedJob] || rawTitle;
    }

    // Enhanced location detection (existing logic)
    let detectedLocation = null;
    let isRemote = false;

    for (const [key, value] of Object.entries(this.locations)) {
      if (text.includes(key)) {
        detectedLocation = value;
        if (key === 'remote') {
          isRemote = true;
        }
        break;
      }
    }

    // Handle complete queries (both job and location found)
    if (detectedJob && detectedLocation) {
      const searchPhrase = this.getRandomSearchPhrase(friendlyJobLabel, detectedLocation);
      
      return {
        action: 'search_jobs',
        response: searchPhrase,
        filters: {
          title: detectedJob,
          rawTitle: rawTitle,
          friendlyLabel: friendlyJobLabel,
          location: detectedLocation,
          remote: isRemote
        }
      };
    }
    
    // Handle partial queries with session context
    if (detectedJob && !detectedLocation && sessionData.lastLocation) {
      const searchPhrase = this.getRandomSearchPhrase(friendlyJobLabel, sessionData.lastLocation);
      
      return {
        action: 'search_jobs',
        response: searchPhrase,
        filters: {
          title: detectedJob,
          rawTitle: rawTitle,
          friendlyLabel: friendlyJobLabel,
          location: sessionData.lastLocation,
          remote: sessionData.lastLocation.toLowerCase() === 'remote'
        }
      };
    }
    
    if (detectedLocation && !detectedJob && sessionData.lastJobType) {
      const lastFriendlyLabel = this.jobLabels[sessionData.lastJobType] || sessionData.lastJobType;
      const searchPhrase = this.getRandomSearchPhrase(lastFriendlyLabel, detectedLocation);
      
      return {
        action: 'search_jobs',
        response: searchPhrase,
        filters: {
          title: sessionData.lastJobType,
          rawTitle: sessionData.lastJobType,
          friendlyLabel: lastFriendlyLabel,
          location: detectedLocation,
          remote: isRemote
        }
      };
    }
    
    // Handle job search keywords without specific job/location
    if (text.includes('job') || text.includes('work') || text.includes('find')) {
      if (detectedJob && !detectedLocation) {
        return {
          action: 'clarify',
          response: `What location for ${friendlyJobLabel} jobs? Try: Lagos, Abuja, or Remote`,
          filters: { 
            title: detectedJob,
            rawTitle: rawTitle,
            friendlyLabel: friendlyJobLabel
          }
        };
      }
      
      if (detectedLocation && !detectedJob) {
        return {
          action: 'clarify',
          response: `What type of jobs in ${detectedLocation}? Try: Developer, Sales & Marketing, or Accounting jobs`,
          filters: { location: detectedLocation, remote: isRemote }
        };
      }
      
      // General job search request
      return {
        action: 'clarify',
        response: 'What type of jobs are you looking for?\n\n• "developer jobs in Lagos"\n• "remote sales jobs"\n• "accounting jobs in Abuja"'
      };
    }
    
    // Handle greetings
    if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
      return {
        action: 'greeting',
        response: 'Hello! I help you find jobs in Nigeria 🇳🇬\n\nTry: "Find developer jobs in Lagos" or "help" for commands'
      };
    }
    
    // Handle help requests
    if (text.includes('help') || text.includes('command')) {
      return {
        action: 'help',
        response: this.getHelpMessage()
      };
    }
    
    return null;
  }

  // Your existing methods remain unchanged...
  async parseWithAI(message, identifier, userContext = null) {
    try {
      const jobId = `${identifier}-${Date.now()}`;
      
      const job = await openaiQueue.add(
        'parse-query',
        { 
          message,
          userId: identifier,
          userContext: userContext || {},
          timestamp: Date.now(),
          platform: userContext?.platform || 'whatsapp'
        },
        {
          jobId: jobId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 1000 }
        }
      );

      logger.info('Job added to queue', { jobId: job.id });

      try {
        const result = await job.waitUntilFinished(queueEvents, 8000);
        
        if (result && (result.action || result.response)) {
          logger.info('AI result received', { jobId: job.id });
          return result;
        }
        
        throw new Error('Invalid AI response structure');
        
      } catch (waitError) {
        logger.warn('waitUntilFinished failed, trying Redis', { 
          error: waitError.message,
          jobId: job.id 
        });
        
        const delays = [100, 200, 400, 800, 1600];
        
        for (const delay of delays) {
          const resultStr = await redis.get(`job-result:${job.id}`);
          if (resultStr) {
            try {
              const result = JSON.parse(resultStr);
              await redis.del(`job-result:${job.id}`);
              logger.info('Got result from Redis fallback', { jobId: job.id });
              return result;
            } catch (parseError) {
              logger.error('Failed to parse Redis result', { error: parseError.message });
            }
          }
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        
        return this.generateIntelligentFallback(message);
      }

    } catch (error) {
      logger.error('AI parsing error', { error: error.message, identifier });
      return this.generateIntelligentFallback(message);
    }
  }

  // All other existing methods remain the same...
  getCacheKey(message) {
    return crypto.createHash('md5')
      .update(message.toLowerCase().trim())
      .digest('hex');
  }

  getFromCache(key) {
    const cached = this.queryCache.get(key);
    if (!cached) return null;
    
    if (Date.now() - cached.timestamp > this.cacheMaxAge) {
      this.queryCache.delete(key);
      return null;
    }
    
    return cached.data;
  }

  setCache(key, data) {
    if (this.queryCache.size >= this.cacheMaxSize) {
      const firstKey = this.queryCache.keys().next().value;
      this.queryCache.delete(firstKey);
    }
    
    this.queryCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  cleanCache() {
    const now = Date.now();
    for (const [key, value] of this.queryCache.entries()) {
      if (now - value.timestamp > this.cacheMaxAge) {
        this.queryCache.delete(key);
      }
    }
  }

  generateIntelligentFallback(message) {
    const text = message.toLowerCase();
    
    if (text.match(/^(hello|hi|hey|good morning|good afternoon|good evening)/)) {
      return {
        action: 'greeting',
        response: 'Hello! Welcome to SmartCVNaija! 🇳🇬\n\nI help people find jobs in Nigeria. What type of work are you looking for?'
      };
    }
    
    if (text.includes('job') || text.includes('work') || text.includes('looking for')) {
      return {
        action: 'clarify',
        response: 'I can help you find jobs! Which city interests you?\n\n📍 Lagos\n📍 Abuja\n📍 Port Harcourt\n📍 Remote opportunities\n\nJust tell me what you\'re looking for!'
      };
    }
    
    return {
      action: 'help',
      response: '🆘 Quick Commands:\n\n• "find jobs in Lagos"\n• "remote developer jobs"\n• "apply 1,2,3" - Apply to jobs\n• "status" - Check your usage\n• Upload CV to get started!\n\nWhat would you like to do?'
    };
  }

  parseSimpleCommand(message) {
    const text = message.toLowerCase().trim();

    const commands = {
      'reset': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'clear': { action: 'reset', response: 'Session cleared! Ready to start fresh! 🚀' },
      'status': { action: 'status', response: 'Checking your status...' },
      'usage': { action: 'status', response: 'Checking your usage...' },
      'help': { action: 'help' },
      'commands': { action: 'help' },
      'start': { action: 'greeting' },
      'menu': { action: 'help' },
    };

    if (commands[text]) {
      return commands[text];
    }

    for (const [key, value] of Object.entries(commands)) {
      if (text.includes(key)) {
        return value;
      }
    }

    if (text.startsWith('apply ')) {
      if (text.includes('all')) {
        return { action: 'apply_job', applyAll: true, jobNumbers: null };
      }
      
      const numbers = this.extractJobNumbers(text);
      if (numbers.length > 0) {
        return { action: 'apply_job', applyAll: false, jobNumbers: numbers };
      }
    }

    if (text === 'next' || text === 'more') {
      return { action: 'browse_next' };
    }
    if (text === 'previous' || text === 'prev' || text === 'back') {
      return { action: 'browse_previous' };
    }

    return null;
  }

  extractJobNumbers(text) {
    const numbers = [];
    const matches = text.match(/\b\d+\b/g);
    
    if (matches) {
      matches.forEach(match => {
        const num = parseInt(match);
        if (num >= 1 && num <= 20) {
          numbers.push(num);
        }
      });
    }
    
    const commaMatch = text.match(/\d+(?:\s*,\s*\d+)*/);
    if (commaMatch) {
      const nums = commaMatch[0].split(',').map(n => parseInt(n.trim()));
      numbers.push(...nums.filter(n => n >= 1 && n <= 20));
    }
    
    return [...new Set(numbers)].sort((a, b) => a - b);
  }

  getHelpMessage() {
    return `🤖 **SmartCVNaija - Job Application Bot**

🔍 **Find Jobs:**
• "Find Developer & Engineering jobs in Lagos"
• "Remote Sales & Marketing jobs"
• "Jobs in Abuja"

💡 **How it works:**
1. Search for jobs (free preview)
2. Pay ₦300 to see full details
3. Select jobs to apply to
4. Upload CV for instant applications

📝 **Apply to Jobs:**
• Select jobs: "Apply to jobs 1,3,5"
• Apply to all: "Apply to all jobs"

📊 **Check Status:** Type "status"

🎯 **Simple Process:** Search → Pay → Select → Upload → Apply!`;
  }

  async generateCoverLetter(cvText, jobTitle = null, companyName = null, applicantName = null, identifier = null) {
      const startTime = Date.now();
      
      try {
        const job = await openaiQueue.add(
          'generate-cover-letter',
          { 
            cvText, 
            jobTitle, 
            companyName, 
            applicantName: applicantName || '[Your Name]',
            userId: identifier 
          },
          { 
            jobId: `cover-${identifier || 'anon'}-${Date.now()}`,
            attempts: 1,
            ttl: 15000,
            removeOnFail: true,
            removeOnComplete: true
          }
        );
        
        try {
          // FIXED: Updated timeout to 65000
          const result = await job.waitUntilFinished(queueEvents, 65000);
          const duration = Date.now() - startTime;
          
          // FIXED: Lowered validation threshold from 100 to 50 characters
          if (typeof result === 'string' && result.length > 50) {
            logger.info('Cover letter generated via AI', {
              identifier: identifier?.substring(0, 6) + '***',
              duration: `${duration}ms`,
              letterLength: result.length,
              source: 'AI'
            });
            return result;
          }
          
          if (result?.content && result.content.length > 50) {
            logger.info('Cover letter generated via AI (nested)', {
              identifier: identifier?.substring(0, 6) + '***',
              duration: `${duration}ms`,
              letterLength: result.content.length,
              source: 'AI'
            });
            return result.content;
          }
          
          throw new Error('AI returned insufficient content');
          
        } catch (waitError) {
          const duration = Date.now() - startTime;
          logger.warn('Cover letter generation timeout - using fallback', {
            identifier: identifier?.substring(0, 6) + '***',
            duration: `${duration}ms`,
            error: waitError.message,
            source: 'Fallback'
          });
          
          try {
            await job.remove();
          } catch (cleanupError) {
            // Ignore cleanup errors
          }
          
          return this.getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName);
        }
        
      } catch (error) {
        const duration = Date.now() - startTime;
        logger.error('Cover letter generation failed completely', {
          identifier: identifier?.substring(0, 6) + '***',
          duration: `${duration}ms`,
          error: error.message,
          source: 'Fallback'
        });
        
        return this.getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName);
      }
    }
  async extractUserInfo(cvText, identifier) {
    try {
      const job = await openaiQueue.add(
        'extract-user-info',
        { 
          cvText, 
          identifier 
        },
        { 
          jobId: `extract-${identifier || 'anon'}-${Date.now()}`,
          attempts: 2,
          ttl: 30000,
          removeOnFail: true,
          removeOnComplete: true
        }
      );
      
      const result = await job.waitUntilFinished(queueEvents, 35000);
      
      if (result && result.name) {
        logger.info('User info extracted via AI', {
          identifier: identifier?.substring(0, 6) + '***',
          name: result.name,
          source: 'AI'
        });
        return result;
      }
      
      throw new Error('AI extraction returned invalid result');
      
    } catch (error) {
      logger.error('AI user info extraction failed in service', {
        identifier: identifier?.substring(0, 6) + '***',
        error: error.message
      });
      throw error;
    }
  }
  
  // FIXED: Added all missing validation methods
  cleanAndValidateName(name) {
    if (!name || typeof name !== 'string') return '';
  
    const cleaned = name
        .replace(/[^\w\s\-'.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (cleaned.length >= 4 && cleaned.length <= 50) {
        const words = cleaned.split(' ').filter(word => word.length > 1);
        
        if (words.length >= 2) {
          const badWords = ['experience', 'team', 'leadership', 'skills', 'cv', 'resume', 'information'];
          const hasBadWords = words.some(word => 
            badWords.includes(word.toLowerCase())
          );
          
          if (!hasBadWords) {
            return cleaned;
          }
        }
      }
      
      return '';
    }
  
    cleanAndValidateEmail(email) {
      if (!email || typeof email !== 'string') return '';
      
      const cleaned = email.trim().toLowerCase();
      const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
      
      if (emailRegex.test(cleaned)) {
        const badDomains = ['example.com', 'test.com', 'smartcvnaija.com'];
        const domain = cleaned.split('@')[1];
        
        if (!badDomains.includes(domain)) {
          return cleaned;
        }
      }
      
      return '';
    }
  
    cleanAndValidatePhone(phone, identifier) {
      if (!phone || typeof phone !== 'string') return identifier;
      
      const cleaned = phone.replace(/[^\d+]/g, '');
      const patterns = [
        /^(\+234|234)\d{10}$/,
        /^0\d{10}$/
      ];
      
      if (patterns.some(pattern => pattern.test(cleaned))) {
        return cleaned;
      }
      
      return identifier;
    }
  
    // Enhanced fallback methods from your original code
    getEnhancedFallbackCoverLetter(cvText, jobTitle, companyName, applicantName = '[Your Name]') {
      try {
        const cvInfo = this.extractBasicCVInfo(cvText || '');
        const jobSpecific = this.getJobSpecificContent(jobTitle, cvInfo);
        
        return `Dear Hiring Manager,
  
  I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}. ${jobSpecific.opening}
  
  ${cvInfo.experienceText} ${jobSpecific.skills} ${cvInfo.skillsText}
  
  I would welcome the opportunity to discuss how my background can contribute to your team's success. Thank you for considering my application, and I look forward to hearing from you.
  
  Best regards,
  ${applicantName}`;
      } catch (error) {
        logger.error('Enhanced fallback failed, using basic template', { error: error.message });
        return this.getFallbackCoverLetter(jobTitle, companyName, applicantName);
      }
    }
  
    extractBasicCVInfo(cvText) {
      const text = cvText.toLowerCase();
      
      let education = '';
      if (text.includes('bachelor') || text.includes('bsc') || text.includes('b.sc')) {
        education = 'bachelor\'s degree';
      } else if (text.includes('master') || text.includes('msc') || text.includes('m.sc')) {
        education = 'master\'s degree';
      } else if (text.includes('hnd') || text.includes('diploma')) {
        education = 'diploma';
      } else if (text.includes('university') || text.includes('college')) {
        education = 'university education';
      }
  
      let yearsExp = '';
      const yearMatches = text.match(/(\d+)\s*years?\s*(of\s*)?(experience|exp)/);
      if (yearMatches) {
        yearsExp = `${yearMatches[1]} years of experience`;
      } else if (text.includes('experienced') || text.includes('experience')) {
        yearsExp = 'relevant experience';
      }
  
      const skills = [];
      const skillKeywords = ['excel', 'microsoft office', 'accounting software', 'quickbooks', 'sap', 'sql', 'javascript', 'python', 'photoshop', 'autocad', 'project management'];
      skillKeywords.forEach(skill => {
        if (text.includes(skill)) {
          skills.push(skill);
        }
      });
  
      let experienceText = '';
      if (education && yearsExp) {
        experienceText = `With my ${education} and ${yearsExp}, I am well-positioned for this role.`;
      } else if (education) {
        experienceText = `My ${education} has provided me with a strong foundation for this position.`;
      } else if (yearsExp) {
        experienceText = `My ${yearsExp} has prepared me well for this opportunity.`;
      } else {
        experienceText = 'My professional background has equipped me with relevant skills for this position.';
      }
  
      let skillsText = '';
      if (skills.length > 0) {
        const skillsList = skills.slice(0, 3).join(', ');
        skillsText = `My proficiency in ${skillsList} aligns well with your requirements.`;
      }
  
      return {
        education,
        yearsExp,
        skills,
        experienceText,
        skillsText
      };
    }
  
    getJobSpecificContent(jobTitle, cvInfo) {
      const title = (jobTitle || '').toLowerCase();
      
      if (title.includes('account') || title.includes('finance')) {
        return {
          opening: `My background in accounting and financial management, combined with ${cvInfo.experienceText ? 'my professional experience' : 'my educational foundation'}, makes me well-suited for this role.`,
          skills: 'My understanding of financial processes and attention to detail position me well for this accounting role.'
        };
      } else if (title.includes('developer') || title.includes('software') || title.includes('it')) {
        return {
          opening: 'My technical background and passion for technology make me an ideal candidate for this development position.',
          skills: 'My programming knowledge and problem-solving abilities align with your technical requirements.'
        };
      } else if (title.includes('marketing') || title.includes('sales')) {
        return {
          opening: 'My experience in client relations and understanding of market dynamics prepare me well for this marketing role.',
          skills: 'My communication skills and market awareness make me a strong candidate for your sales team.'
        };
      } else if (title.includes('manager') || title.includes('supervisor')) {
        return {
          opening: 'My leadership capabilities and management experience make me well-qualified for this supervisory position.',
          skills: 'My ability to coordinate teams and manage projects effectively suits your management requirements.'
        };
      }
      
      return {
        opening: `My professional background and ${cvInfo.education || 'educational foundation'} make me a qualified candidate for this role.`,
        skills: 'My relevant skills and dedication to excellence position me well for this opportunity.'
      };
    }
  
    getFallbackCoverLetter(jobTitle = null, companyName = null, applicantName = '[Your Name]') {
      return `Dear Hiring Manager,
  
  I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}.
  
  My background and experience make me a qualified candidate for this role in Nigeria's competitive market. I have developed strong skills that align with your requirements and am confident in my ability to contribute to your team.
  
  I would welcome the opportunity to discuss how my experience can benefit your organization. Thank you for considering my application.
  
  Best regards,
  ${applicantName}`;
    }
  
    getRandomSearchPhrase(jobType, location) {
      const phrase = this.searchPhrases[Math.floor(Math.random() * this.searchPhrases.length)];
      return phrase.replace('{jobType}', jobType).replace('{location}', location);
    }
   logMetrics() {
      try {
        logger.info('AIService metrics', {
          cacheSize: this.queryCache.size,
          cacheHits: this.metrics.cacheHits,
          patternMatches: this.metrics.patternMatches,
          aiCalls: this.metrics.aiCalls,
          totalRequests: this.metrics.totalRequests,
          cacheHitRate: this.metrics.totalRequests > 0 
            ? ((this.metrics.cacheHits / this.metrics.totalRequests) * 100).toFixed(2) + '%'
            : '0%',
          aiCallRate: this.metrics.totalRequests > 0 
            ? ((this.metrics.aiCalls / this.metrics.totalRequests) * 100).toFixed(2) + '%'
            : '0%'
        });
      } catch (error) {
        logger.error('Failed to log metrics', { error: error.message });
      }
    }
    // NEW: Method to clear session data for testing
    async clearSessionData(identifier) {
      if (identifier) {
        try {
          await sessionRedis.del(`session:${identifier}`);
          logger.info('Session data cleared', { identifier });
          return true;
        } catch (error) {
          logger.error('Failed to clear session data', { identifier, error: error.message });
          return false;
        }
      }
      return false;
    }
  }
  
  module.exports = new AIService();