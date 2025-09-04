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
      'developer': 'engineering_technical',
      'programmer': 'engineering_technical', 
      'software engineer': 'engineering_technical',
      'frontend': 'engineering_technical',
      'backend': 'engineering_technical',
      'fullstack': 'engineering_technical',
      'web developer': 'engineering_technical',
      'mobile developer': 'engineering_technical',
      'data scientist': 'engineering_technical',
      'devops': 'engineering_technical',
      'system administrator': 'engineering_technical',
      
      'sales rep': 'marketing_sales',
      'sales representative': 'marketing_sales',
      'marketer': 'marketing_sales',
      'business development': 'marketing_sales',
      'account manager': 'marketing_sales',
      'digital marketer': 'marketing_sales',
      'marketing manager': 'marketing_sales',
      'sales manager': 'marketing_sales',
      'brand manager': 'marketing_sales',
      
      'accountant': 'accounting_finance',
      'finance': 'accounting_finance',
      'bookkeeper': 'accounting_finance',
      'financial analyst': 'accounting_finance',
      'audit': 'accounting_finance',
      'tax': 'accounting_finance',
      'treasury': 'accounting_finance',
      'budget analyst': 'accounting_finance',
      
      'admin': 'admin_office',
      'administrator': 'admin_office',
      'office assistant': 'admin_office',
      'secretary': 'admin_office',
      'receptionist': 'admin_office',
      'data entry': 'admin_office',
      'clerk': 'admin_office',
      'coordinator': 'admin_office',
      
      'manager': 'management_executive',
      'director': 'management_executive',
      'supervisor': 'management_executive',
      'team lead': 'management_executive',
      'executive': 'management_executive',
      'head of': 'management_executive',
      'ceo': 'management_executive',
      'operations manager': 'management_executive',
      
      'teacher': 'education_training',
      'instructor': 'education_training',
      'trainer': 'education_training',
      'tutor': 'education_training',
      'lecturer': 'education_training',
      'professor': 'education_training',
      'education': 'education_training',
      
      'nurse': 'healthcare_medical',
      'doctor': 'healthcare_medical',
      'physician': 'healthcare_medical',
      'medical': 'healthcare_medical',
      'healthcare': 'healthcare_medical',
      'pharmacist': 'healthcare_medical',
      'laboratory': 'healthcare_medical',
      'clinical': 'healthcare_medical',
      
      'customer service': 'customer_service',
      'customer support': 'customer_service',
      'call center': 'customer_service',
      'help desk': 'customer_service',
      'client service': 'customer_service',
      
      'hr': 'human_resources',
      'human resources': 'human_resources',
      'recruiter': 'human_resources',
      'talent': 'human_resources',
      'payroll': 'human_resources',
      'benefits': 'human_resources',
      
      'logistics': 'logistics_supply',
      'supply chain': 'logistics_supply',
      'warehouse': 'logistics_supply',
      'procurement': 'logistics_supply',
      'shipping': 'logistics_supply',
      'inventory': 'logistics_supply',
      
      'security': 'security_safety',
      'guard': 'security_safety',
      'safety': 'security_safety',
      'surveillance': 'security_safety',
      
      'driver': 'transport_driving',
      'transport': 'transport_driving',
      'delivery': 'transport_driving',
      'courier': 'transport_driving',
      
      'engineer': 'engineering_technical',
      'technician': 'engineering_technical',
      'maintenance': 'engineering_technical',
      'mechanical': 'engineering_technical',
      'electrical': 'engineering_technical',
      'civil': 'engineering_technical',
      'chemical': 'engineering_technical',
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

  // All other existing methods remain unchanged (analyzeCV, generateCoverLetter, etc.)...
  async analyzeCV(cvText, jobTitle = null, identifier = null) {
    try {
      const job = await openaiQueue.add(
        'analyze-cv',
        { cvText, jobTitle, userId: identifier },
        { jobId: `cv-${identifier}-${Date.now()}` }
      );
      
      try {
        const result = await job.waitUntilFinished(queueEvents, 15000);
        return this.validateCVAnalysis(result) || this.getFallbackAnalysis(cvText, jobTitle);
      } catch (error) {
        logger.warn('CV analysis timeout', { identifier });
        return this.getFallbackAnalysis(cvText, jobTitle);
      }
    } catch (error) {
      logger.error('CV analysis error', { error: error.message });
      return this.getFallbackAnalysis(cvText, jobTitle);
    }
  }

  validateCVAnalysis(result) {
    if (!result || typeof result !== 'object') return null;
    
    if (result.content && typeof result.content === 'object') {
      result = result.content;
    }
    
    const requiredFields = [
      'overall_score', 'job_match_score', 'skills_score',
      'experience_score', 'education_score', 'experience_years'
    ];
    
    for (const field of requiredFields) {
      if (!(field in result)) return null;
    }
    
    return result;
  }

  async generateCoverLetter(cvText, jobTitle = null, companyName = null, identifier = null) {
    try {
      const job = await openaiQueue.add(
        'generate-cover-letter',
        { cvText, jobTitle, companyName, userId: identifier },
        { jobId: `cover-${identifier}-${Date.now()}` }
      );
      
      try {
        const result = await job.waitUntilFinished(queueEvents, 10000);
        
        if (result?.content && result.content.length > 50) {
          return result.content;
        }
        if (typeof result === 'string' && result.length > 50) {
          return result;
        }
        
        return this.getFallbackCoverLetter(jobTitle, companyName);
      } catch (error) {
        logger.warn('Cover letter generation timeout', { identifier });
        return this.getFallbackCoverLetter(jobTitle, companyName);
      }
    } catch (error) {
      logger.error('Cover letter generation error', { error: error.message });
      return this.getFallbackCoverLetter(jobTitle, companyName);
    }
  }

  getFallbackAnalysis(cvText, jobTitle = null) {
    const text = (cvText || '').toLowerCase();
    let overallScore = 50;
    let jobMatchScore = 50;

    if (text.includes('experience')) overallScore += 15;
    if (text.includes('education')) overallScore += 10;
    if (text.includes('skill')) overallScore += 10;

    if (jobTitle && text.includes(jobTitle.toLowerCase())) {
      jobMatchScore += 20;
    }
    
    return {
      overall_score: Math.min(Math.max(overallScore, 0), 100),
      job_match_score: Math.min(Math.max(jobMatchScore, 0), 100),
      skills_score: 60,
      experience_score: 50,
      education_score: 60,
      experience_years: 2,
      key_skills: ['Communication', 'Teamwork', 'Problem Solving'],
      relevant_skills: ['Professional Experience', 'Leadership'],
      education_level: 'Bachelor\'s',
      summary: 'Professional with relevant experience',
      strengths: ['Strong educational background', 'Good communication'],
      areas_for_improvement: ['More certifications', 'Industry experience'],
      recommendation: 'Good',
      cv_quality: 'Good',
      personalized_message: 'Great potential for the Nigerian job market!'
    };
  }

  getFallbackCoverLetter(jobTitle = null, companyName = null) {
    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${jobTitle || 'position'} at ${companyName || 'your company'}.

My background and experience make me a qualified candidate for this role in Nigeria's competitive market. I have developed strong skills that align with your requirements and am confident in my ability to contribute to your team.

I would welcome the opportunity to discuss how my experience can benefit your organization. Thank you for considering my application.

Best regards,
[Your Name]`;
  }

  logMetrics() {
    const total = this.metrics.totalRequests;
    if (total === 0) return;

    const cacheHitRate = Math.round((this.metrics.cacheHits / total) * 100);
    const patternRate = Math.round((this.metrics.patternMatches / total) * 100);
    const aiRate = Math.round((this.metrics.aiCalls / total) * 100);

    logger.info('Performance metrics', {
      totalRequests: total,
      cacheHitRate: `${cacheHitRate}%`,
      patternMatchRate: `${patternRate}%`,
      aiCallRate: `${aiRate}%`,
      cacheSize: this.queryCache.size
    });

    // Reset metrics
    this.metrics = { cacheHits: 0, patternMatches: 0, aiCalls: 0, totalRequests: 0 };
  }
}

module.exports = new AIService();