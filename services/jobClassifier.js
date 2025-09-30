// services/jobClassifier.js - AI-powered job classification

const logger = require('../utils/logger');

class JobClassifier {
  constructor(aiService) {
    this.aiService = aiService;
    
    // Clean job categories (no overlapping keywords)
    this.jobCategories = {
      'it_software': {
        label: 'IT & Software Development',
        description: 'Programming, software development, system administration, cybersecurity'
      },
      'engineering_technical': {
        label: 'Engineering & Technical',
        description: 'Mechanical, electrical, civil, chemical engineering, technical roles'
      },
      'accounting_finance': {
        label: 'Accounting & Finance',
        description: 'Accounting, bookkeeping, financial analysis, audit, banking'
      },
      'healthcare_medical': {
        label: 'Healthcare & Medical',
        description: 'Doctors, nurses, medical technicians, healthcare workers'
      },
      'marketing_sales': {
        label: 'Sales & Marketing',
        description: 'Sales representatives, marketing, business development, advertising'
      },
      'education_training': {
        label: 'Education & Training',
        description: 'Teachers, trainers, instructors, educational roles'
      },
      'admin_office': {
        label: 'Administration & Office',
        description: 'Administrative assistants, office support, secretarial work'
      },
      'management_executive': {
        label: 'Management & Executive',
        description: 'Managers, supervisors, directors, leadership roles'
      },
      'human_resources': {
        label: 'Human Resources',
        description: 'HR specialists, recruiters, talent acquisition, payroll'
      },
      'customer_service': {
        label: 'Customer Service',
        description: 'Customer support, call center, client service'
      },
      'logistics_supply': {
        label: 'Logistics & Supply Chain',
        description: 'Logistics, warehouse, supply chain, procurement'
      },
      'legal_compliance': {
        label: 'Legal & Compliance',
        description: 'Lawyers, legal advisors, compliance officers'
      },
      'media_creative': {
        label: 'Media & Creative',
        description: 'Graphic design, content creation, journalism, photography'
      },
      'security_safety': {
        label: 'Security & Safety',
        description: 'Security guards, safety officers, surveillance'
      },
      'transport_driving': {
        label: 'Transport & Driving',
        description: 'Drivers, delivery, transportation, logistics'
      },
      'construction_real_estate': {
        label: 'Construction & Real Estate',
        description: 'Construction workers, real estate, building trades'
      },
      'manufacturing_production': {
        label: 'Manufacturing & Production',
        description: 'Factory workers, production, manufacturing, assembly'
      },
      'retail_fashion': {
        label: 'Retail & Fashion',
        description: 'Retail sales, fashion, merchandising, store operations'
      },
      'other_general': {
        label: 'General Jobs',
        description: 'Entry-level, general labor, miscellaneous opportunities'
      }
    }; // FIXED: Closed jobCategories object here

    // Nigerian locations
    this.locations = {
      'lagos': 'Lagos',
      'abuja': 'Abuja', 
      'kano': 'Kano',
      'port harcourt': 'Rivers',
      'ibadan': 'Oyo',
      'kaduna': 'Kaduna',
      'enugu': 'Enugu',
      'jos': 'Plateau',
      'calabar': 'Cross River',
      'warri': 'Delta',
      'benin': 'Edo',
      'maiduguri': 'Borno',
      'ilorin': 'Kwara',
      'aba': 'Abia',
      'onitsha': 'Anambra',
      'katsina': 'Katsina',
      'sokoto': 'Sokoto',
      'bauchi': 'Bauchi',
      'gombe': 'Gombe',
      'yola': 'Adamawa',
      'remote': 'Remote'
    };
  }

  // Main classification method
  async classifyJobQuery(message, userContext = {}) {
    const text = message.toLowerCase().trim();
    
    // Quick location detection (no AI needed)
    const detectedLocation = this.detectLocation(text);
    
    // Quick job type detection for obvious cases
    const quickJobType = this.detectObviousJobType(text);
    if (quickJobType) {
      return {
        jobType: quickJobType,
        jobLabel: this.jobCategories[quickJobType].label,
        location: detectedLocation,
        confidence: 'high',
        source: 'pattern_match'
      };
    }

    // Use AI for complex cases
    try {
      const aiResult = await this.aiClassifyJob(text, userContext);
      return {
        ...aiResult,
        location: detectedLocation || aiResult.location,
        source: 'ai_classification'
      };
    } catch (error) {
      logger.error('AI classification failed', { error: error.message });
      return {
        jobType: 'other_general',
        jobLabel: 'General Jobs',
        location: detectedLocation,
        confidence: 'low',
        source: 'fallback'
      };
    }
  }

  // Quick pattern matching for obvious job types - FIXED LOCATION
  detectObviousJobType(text) {
    const patterns = {
      'it_software': [
        /\b(developer|programmer|software|coding|programming)\b/,
        /\b(web dev|mobile dev|frontend|backend|fullstack)\b/,
        /\b(javascript|python|php|react|nodejs)\b/,
        /\b(cyber security|network admin|system admin)\b/
      ],
      'accounting_finance': [
        /\b(accountant|accounting|bookkeeper|audit)\b/,
        /\b(finance|financial|treasury|tax)\b/,
        /\b(account|accounts|acct|account\s*officer|account\s*clerk)\b/
      ],
      'healthcare_medical': [
        /\b(doctor|nurse|medical|healthcare|physician)\b/,
        /\b(clinical|hospital|pharmacy|laboratory)\b/
      ],
      'engineering_technical': [
        /\b(mechanical engineer|electrical engineer|civil engineer)\b/,
        /\b(chemical engineer|petroleum engineer|site engineer)\b/,
        /\b(maintenance engineer|process engineer)\b/
      ],
      'marketing_sales': [
        /\b(sales|marketing|business development)\b/,
        /\b(account manager|brand manager|digital marketing)\b/
      ],
      'education_training': [
        /\b(teacher|instructor|trainer|tutor|lecturer)\b/
      ],
      'customer_service': [
        /\b(customer service|customer support|call center)\b/
      ],
      'transport_driving': [
        /\b(driver|delivery|transport|courier)\b/
      ],
      // NEW PATTERNS FOR MISSED JOBS:
      'legal_compliance': [
        /\b(lawyer|attorney|legal|barrister|solicitor|paralegal)\b/,
        /\b(legal officer|legal advisor|compliance)\b/
      ],
      'media_creative': [
        /\b(video editor|video editing|video production)\b/,
        /\b(graphic designer|graphics|designer|creative)\b/,
        /\b(photographer|photography|videographer)\b/,
        /\b(content creator|content writer|journalist)\b/,
        /\b(animator|animation|illustrator)\b/
      ],
      'admin_office': [
        /\b(secretary|receptionist|admin|administrator)\b/,
        /\b(office manager|office assistant|clerical)\b/,
        /\b(data entry|executive assistant|personal assistant)\b/
      ],
      'human_resources': [
        /\b(hr |human resources|recruiter|recruitment)\b/,
        /\b(talent acquisition|payroll|people operations)\b/
      ],
      'security_safety': [
        /\b(security guard|security officer|safety officer)\b/,
        /\b(surveillance|hse officer|safety inspector)\b/
      ],
      'construction_real_estate': [
        /\b(architect|construction|builder|real estate)\b/,
        /\b(property manager|estate agent|quantity surveyor)\b/
      ],
      'retail_fashion': [
        /\b(shop|retail|store|sales assistant|cashier)\b/,
        /\b(fashion|stylist|merchandiser)\b/
      ],
      'manufacturing_production': [
        /\b(factory|production|manufacturing|assembly)\b/,
        /\b(quality control|quality assurance|plant operator)\b/
      ],
      'logistics_supply': [
        /\b(logistics|warehouse|supply chain|inventory)\b/,
        /\b(procurement|purchasing|store keeper)\b/
      ]
    };

    for (const [category, regexArray] of Object.entries(patterns)) {
      if (regexArray.some(regex => regex.test(text))) {
        return category;
      }
    }

    return null;
  }

  // Location detection
  detectLocation(text) {
    for (const [key, value] of Object.entries(this.locations)) {
      if (text.includes(key)) {
        return value;
      }
    }
    return null;
  }

  // AI-powered classification for complex queries
  async aiClassifyJob(text, userContext = {}) {
    const systemPrompt = `You are a Nigerian job classification expert. Classify job queries into specific categories.

AVAILABLE CATEGORIES:
- it_software: IT & Software Development (developers, programmers, web dev, mobile dev, cybersecurity, system admin)
- engineering_technical: Engineering & Technical (mechanical, electrical, civil, chemical engineering)
- accounting_finance: Accounting & Finance (accountants, bookkeepers, auditors, financial analysts)
- healthcare_medical: Healthcare & Medical (doctors, nurses, lab technicians, pharmacists)
- marketing_sales: Sales & Marketing (sales reps, marketing, business development)
- education_training: Education & Training (teachers, trainers, lecturers, instructors)
- admin_office: Administration & Office (secretaries, receptionists, admin assistants, data entry)
- management_executive: Management & Executive (managers, directors, supervisors, CEOs)
- human_resources: Human Resources (HR specialists, recruiters, payroll officers)
- customer_service: Customer Service (support agents, call center, client relations)
- logistics_supply: Logistics & Supply Chain (warehouse, inventory, procurement)
- legal_compliance: Legal & Compliance (LAWYERS, attorneys, paralegals, legal officers)
- media_creative: Media & Creative (VIDEO EDITORS, graphic designers, photographers, content creators, journalists)
- security_safety: Security & Safety (security guards, safety officers, HSE)
- transport_driving: Transport & Driving (drivers, delivery, couriers)
- construction_real_estate: Construction & Real Estate (architects, builders, property managers)
- manufacturing_production: Manufacturing & Production (factory workers, quality control)
- retail_fashion: Retail & Fashion (shop attendants, cashiers, fashion designers)
- other_general: General Jobs (any job that doesn't fit above categories)

IMPORTANT MAPPINGS:
- "lawyer" or any legal role → legal_compliance
- "video editor" or video production → media_creative
- "graphic designer" or creative roles → media_creative
- "secretary" or admin roles → admin_office
 - "account", "accounts", "acct", "account officer" → accounting_finance

Return JSON only:
{
  "jobType": "category_key",
  "jobLabel": "Human Readable Label", 
  "confidence": "high|medium|low",
  "reasoning": "brief explanation"
}`;

    const userPrompt = `Classify this job query: "${text}"
${userContext.sessionData ? `Context: Previous searches included ${JSON.stringify(userContext.sessionData)}` : ''}

Return classification as JSON.`;

    try {
      const response = await this.aiService.callAIWithContext([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ]);

      const result = this.parseAIResponse(response.content);
      
      if (!result.jobType || !this.jobCategories[result.jobType]) {
        throw new Error('Invalid job category returned');
      }

      return {
        jobType: result.jobType,
        jobLabel: this.jobCategories[result.jobType].label,
        confidence: result.confidence || 'medium',
        reasoning: result.reasoning || 'AI classification'
      };

    } catch (error) {
      logger.error('AI job classification error', { error: error.message, text });
      throw error;
    }
  }

  // Parse AI response
  parseAIResponse(content) {
    try {
      let cleaned = content.trim();
      
      // Remove markdown code blocks
      if (cleaned.startsWith('```json')) {
        cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
      }

      return JSON.parse(cleaned);
    } catch (error) {
      logger.error('Failed to parse AI classification response', { 
        content: content.substring(0, 200),
        error: error.message 
      });
      throw new Error('Invalid AI response format');
    }
  }

  // Get category information
  getCategoryInfo(categoryKey) {
    return this.jobCategories[categoryKey] || this.jobCategories['other_general'];
  }

  // Get all categories for UI
  getAllCategories() {
    return this.jobCategories;
  }

  // Get all locations for UI  
  getAllLocations() {
    return this.locations;
  }

  // Smart search phrase generation
  generateSearchPhrase(jobType, location, confidence = 'high') {
    const jobLabel = this.jobCategories[jobType]?.label || 'jobs';
    const locationName = location || 'Nigeria';
    
    const phrases = [
      `Searching for ${jobLabel} in ${locationName}...`,
      `Looking for ${jobLabel} opportunities in ${locationName}...`,
      `Finding ${jobLabel} positions in ${locationName}...`,
      `Checking ${jobLabel} openings in ${locationName}...`
    ];

    if (confidence === 'low') {
      phrases.push(`Searching general jobs in ${locationName} (please be more specific)...`);
    }

    return phrases[Math.floor(Math.random() * phrases.length)];
  }
}

module.exports = JobClassifier;